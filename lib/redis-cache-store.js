'use strict'

const { Readable, Writable } = require('node:stream')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')

/**
 * TODO remove this typedef when there's an upstream type we can reference
 * @typedef {{
 *  statusCode: number;
 *  statusMessage: string;
 *  rawHeaders: Buffer[];
 *  rawTrailers?: string[];
 *  vary?: Record<string, string>;
 *  cachedAt: number;
 *  staleAt: number;
 *  deleteAt: number;
 * }} CacheStoreValue
 *
 * @typedef {{
 *  key: string
 *  vary?: Record<string, string>
 * }} RedisMetadataValue
 *
 * @typedef {{
 *  deleteAt: number
 *  values: RedisMetadataValue[]
 * }} RedisValueMetadata
 *
 * @typedef {{
 *  statusCode: number;
 *  statusMessage: string;
 *  rawHeaders: string[];
 *  rawTrailers?: string[];
 *  vary?: string;
 *  cachedAt: number;
 *  staleAt: number;
 *  deleteAt: number;
 *  body: string[]
 * }} RedisValue
 *
 * @typedef {{
 *  deleteAt: number
 *  hasVaryHashes: boolean
 *  varyHeaders?: string[]
 *  varyHashes?: Record<string, number>
 * }} ValueVaryHashes
 */
class RedisCacheStore {
  #maxEntrySize = Infinity

  /**
   * @type {((err: Error) => void) | undefined}
   */
  #errorCallback

  /**
   * Redis client used for fetching data
   * @type {Redis}
   */
  #dataClient

  /**
   * @type {TrackingCache | Redis}
   */
  #dataCache

  /**
   * @param {import('../index.d.ts').RedisCacheStoreOpts | undefined} opts
   */
  constructor (opts) {
    let redisClientOpts

    let tracking = true
    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      if (opts.clientOpts) {
        redisClientOpts = opts.clientOpts
      }

      if (opts.maxEntrySize) {
        if (typeof opts.maxEntrySize !== 'number') {
          throw new TypeError('expected opts.maxEntrySize to be a number')
        }
        this.#maxEntrySize = opts.maxEntrySize
      }

      if (opts.tracking === false) {
        tracking = false
      }

      if (opts.errorCallback) {
        if (typeof opts.errorCallback !== 'function') {
          throw new TypeError('expected opts.errorCallback to be a function')
        }
        this.#errorCallback = opts.errorCallback
      }
    }

    this.#dataClient = new Redis(redisClientOpts)

    if (tracking) {
      this.#dataCache = new TrackingCache(
        this.#dataClient,
        redisClientOpts,
        this.#errorCallback
      )
    } else {
      this.#dataCache = this.#dataClient
    }
  }

  get isFull () {
    return false
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    return this.#dataCache === this.#dataClient
      ? this.#dataClient.quit()
      : Promise.allSettled([this.#dataClient.quit(), this.#dataCache.quit()])
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {Promise<RedisStoreReadable | undefined>}
   */
  async createReadStream (req) {
    if (typeof req !== 'object') {
      throw new TypeError(`expected req to be object, got ${typeof req}`)
    }

    const metadataKey = this.#makeKey(req)
    const metadataValuesString = await this.#dataCache.hget(
      metadataKey,
      'values'
    )

    if (!metadataValuesString) {
      // Key doesn't exist, there's no response cached for this request
      return undefined
    }

    /**
     * @type {RedisMetadataValue[]}
     */
    const metadataValues = JSON.parse(metadataValuesString)

    const metadataValue = this.#findValueFromVaryHeaders(req, metadataValues)
    if (!metadataValue) {
      return undefined
    }

    // Grab the value from redis
    const valueString = await this.#dataCache.get(metadataValue.key)
    if (!valueString) {
      // The value expired, let's remove it from the list
      this.#dataClient.hmset(metadataKey, {
        values: JSON.stringify(
          metadataValues.filter(value => value !== metadataValue)
        )
      }).catch(err => {
        if (this.#errorCallback) {
          this.#errorCallback(err)
        }
      })

      return undefined
    }

    /**
     * @type {RedisValue}
     */
    const value = JSON.parse(valueString)

    return new RedisStoreReadable(value)
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @param {CacheStoreValue} opts
   * @returns {RedisStoreWritable | undefined}
   */
  createWriteStream (req, opts) {
    if (typeof req !== 'object') {
      throw new TypeError(`expected req to be object, got ${typeof req}`)
    }

    if (typeof opts !== 'object') {
      throw new TypeError(`expected opts to be object, got ${typeof opts}`)
    }

    if (this.isFull) {
      return undefined
    }

    const writable = new RedisStoreWritable(this.#maxEntrySize)

    let errored = false

    writable.on('end', () => {
      if (errored) {
        return
      }

      const sendToRedis = async () => {
        const metadataKey = this.#makeKey(req)

        /**
         * @type {{
         *  deleteAt?: string
         *  values?: string
         * }}
         */
        let metadata = await this.#dataCache.hgetall(metadataKey)

        let valueKey

        let updateMetadata = false
        let updateExpiresAt = false
        if (metadata.deleteAt) {
          // Metadata exists
          const deleteAt = Number.parseInt(metadata.deleteAt)
          if (opts.deleteAt >= deleteAt) {
            metadata.deleteAt = opts.deleteAt
            updateMetadata = true
            updateExpiresAt = true
          }

          const values = JSON.parse(metadata.values)
          const value = this.#findValueFromVaryHeaders(req, values)

          if (value) {
            // This specific request was already cached, we need to just update
            //  the value in redis
            valueKey = value.key
          } else {
            // This specific request wasn't already cached, need to add the
            //  metadata and the value in redis.

            metadata.values = JSON.stringify([
              ...values,
              {
                key: this.#makeValueKey(req),
                vary: opts.vary
              }
            ])

            updateMetadata = true
          }
        } else {
          // Metadata doesn't exist, no responses to this resource are in redis
          valueKey = this.#makeValueKey(req)

          const value = { key: valueKey }
          if (opts.vary) {
            value.vary = opts.vary
          }

          metadata = {
            deleteAt: opts.deleteAt,
            values: JSON.stringify([value])
          }

          updateMetadata = true
          updateExpiresAt = true
        }

        await this.#dataClient.set(
          valueKey,
          JSON.stringify({
            ...opts,
            rawTrailers: writable.rawTrailers,
            body: stringifyBufferArray(writable.body)
          })
        )

        // Needs to be done after setting the value in case this is a new key
        await this.#dataClient.expireat(valueKey, Math.floor(opts.deleteAt / 1000))

        if (updateMetadata) {
          await this.#dataClient.hmset(metadataKey, metadata)
        }

        if (updateExpiresAt) {
          // Needs to be done after the hset in case this is a new key
          await this.#dataClient.expireat(metadataKey, Math.floor(opts.deleteAt / 1000))
        }
      }

      sendToRedis().catch(err => {
        if (this.#errorCallback) {
          this.#errorCallback(err)
        }
      })
    })

    writable.on('error', () => {
      errored = true
    })

    writable.on('bodyOversized', () => {
      errored = true
    })

    return writable
  }

  /**
   * @param {string} origin
   * @returns {Promise<void>}
   */
  async deleteByOrigin (origin) {
    await Promise.allSettled([
      this.#dataClient.del(`metadata:${origin}:*`),
      this.#dataClient.del(`values:${origin}:*`)
    ])
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeKey (req) {
    return `metadata:${req.origin}:${req.path}:${req.method}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeValueKey (req) {
    return `values:${req.origin}:${crypto.randomUUID()}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @param {RedisMetadataValue[]} valueKey
   * @returns {RedisMetadataValue | undefined}
   */
  #findValueFromVaryHeaders (req, valueKey) {
    // We have multiple values due to the response having a vary header.
    //  Let's find the response that matches
    let value
    for (const currentValue of valueKey) {
      let matches = true

      if (currentValue.vary) {
        if (!req.headers) {
          continue
        }

        for (const key in currentValue.vary) {
          if (req.headers[key] !== currentValue.vary[key]) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        value = currentValue
        break
      }
    }

    return value
  }
}

class RedisStoreReadable extends Readable {
  /**
   * @type {CacheStoreValue}
   */
  #cacheStoreValue

  /**
   * @param {Buffer[]} value
   */
  #chunksToSend = []

  /**
   *
   * @param {RedisValue} value
   */
  constructor (value) {
    super()

    this.#cacheStoreValue = {
      statusCode: value.statusCode,
      statusMessage: value.statusMessage,
      cachedAt: value.cachedAt,
      staleAt: value.staleAt,
      deleteAt: value.deleteAt
    }

    if (value.rawHeaders) {
      this.#cacheStoreValue.rawHeaders = parseBufferArray(value.rawHeaders)
    }

    if (value.rawTrailers) {
      this.#cacheStoreValue.rawTrailers = value.rawTrailers
    }

    if (value.vary) {
      this.#cacheStoreValue.vary = value.vary
    }

    this.#chunksToSend = [...parseBufferArray(value.body), null]
  }

  get value () {
    return this.#cacheStoreValue
  }

  /**
   * @param {number} size
   */
  _read (size) {
    if (this.#chunksToSend.length === 0) {
      throw new Error('no chunks left to read, stream should have closed')
    }

    if (size > this.#chunksToSend.length) {
      size = this.#chunksToSend.length
    }

    for (let i = 0; i < size; i++) {
      this.push(this.#chunksToSend.shift())
    }
  }
}

class RedisStoreWritable extends Writable {
  /**
   * @type {string[]}
   */
  #body = []

  /**
   * @type {string[] | undefined}
   */
  #rawTrailers = undefined

  #currentSize = 0

  #maxEntrySize = 0

  #hasEmittedOversized = false

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @param {CacheStoreValue} opts
   * @param {number} maxEntrySize
   */
  constructor (maxEntrySize) {
    super()
    this.#maxEntrySize = maxEntrySize
  }

  get body () {
    return this.#body
  }

  get rawTrailers () {
    return this.#rawTrailers
  }

  /**
   * @param {string[] | undefined} trailers
   */
  set rawTrailers (trailers) {
    this.#rawTrailers = trailers
  }

  /**
   * @param {Buffer} chunk
   * @param {string} _
   * @param {() => void} callback
   */
  _write (chunk, _, callback) {
    if (typeof chunk === 'object') {
      // chunk is a buffer, we need it to be a string
      chunk = chunk.toString()
    }

    this.#currentSize = chunk.length

    if (this.#currentSize < this.#maxEntrySize) {
      this.#body.push(chunk)
    } else if (!this.#hasEmittedOversized) {
      this.#body = null
      this.emit('bodyOversized')
      this.end()
    }

    callback()
  }

  /**
   * @param {() => void} callback
   */
  _final (callback) {
    this.emit('end')
    callback()
  }
}

/**
 * @param {(Buffer | Buffer[])[]} buffers
 * @returns {(string | string[])[]}
 */
function stringifyBufferArray (buffers) {
  const output = new Array(buffers.length)
  for (let i = 0; i < buffers.length; i++) {
    if (Array.isArray(buffers[i])) {
      output[i] = stringifyBufferArray(buffers[i])
    } else {
      output[i] = buffers[i].toString()
    }
  }

  return output
}

/**
 * @param {(string | string[])[]} strings
 * @returns {(Buffer | Buffer[])[]}
 */
function parseBufferArray (strings) {
  const output = new Array(strings.length)

  for (let i = 0; i < strings.length; i++) {
    if (Array.isArray(strings[i])) {
      output[i] = parseBufferArray(strings[i])
    } else {
      output[i] = Buffer.from(strings[i])
    }
  }

  return output
}

module.exports = RedisCacheStore

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
 *  valueKey: string
 *  vary?: Record<string, string> | string
 * }} RedisMetadataValue
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
   * The prefix for each key in Redis. Redis usually handles this for us, but
   *  `keys` is an exception in both its input and output (we need to pass in
   *  the full key and we get the full keys back out)
   * @type {string}
   * @default ''
   */
  #keyPrefix

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

    this.#keyPrefix = redisClientOpts?.keyPrefix ?? ''
    this.#dataClient = new Redis(redisClientOpts)

    if (tracking) {
      this.#dataCache = new TrackingCache(
        this.#dataClient,
        new Redis(redisClientOpts),
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
    try {
      if (this.#dataCache === this.#dataClient) {
        await this.#dataClient.quit()
      } else {
        await Promise.all([this.#dataCache.quit(), this.#dataClient.quit()])
      }
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {Promise<RedisStoreReadable | undefined>}
   */
  async createReadStream (req) {
    if (typeof req !== 'object') {
      throw new TypeError(`expected req to be object, got ${typeof req}`)
    }

    const baseMetadataKey = this.#makeBaseMetadataKey(req)
    const metadataKeys = await this.#dataClient.keys(
      `${this.#keyPrefix}${baseMetadataKey}*`
    )
    if (metadataKeys.length === 0) {
      // Key doesn't exist most likely, there's no response cached for this request
      return undefined
    }

    const metadataValue = await this.#findExistingMetadataValue(req, metadataKeys)
    if (!metadataValue) {
      return undefined
    }

    // Grab the value from redis
    const valueString = await this.#dataCache.get(metadataValue.valueKey)
    if (!valueString) {
      // The value expired but the metadata stayed around. This shouldn't ever
      //  happen but is technically possible
      this.#dataClient.del(metadataValue.key)
      return undefined
    }

    let value
    try {
      /**
       * @type {RedisValue}
       */
      value = JSON.parse(valueString)
    } catch (err) {
      Promise.all([
        this.#dataClient.del(metadataValue.key),
        this.#dataClient.del()
      ]).catch(err => {
        if (this.#errorCallback) {
          this.#errorCallback(err)
        }
      })

      if (this.#errorCallback) {
        this.#errorCallback(err)
      }

      return undefined
    }

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

    const writable = new RedisStoreWritable(this.#maxEntrySize)

    let errored = false

    writable.on('end', () => {
      if (errored) {
        return
      }

      const sendToRedis = async () => {
        // Let's check if this response already exists in the cache
        const metadataKeyRoot = this.#makeBaseMetadataKey(req)
        const valueKeys = await this.#dataClient.keys(`${metadataKeyRoot}:*`)

        let metadataKey
        let valueKey
        const existingValue = await this.#findExistingMetadataValue(req, valueKeys)
        if (existingValue !== undefined) {
          // Value already exists & we're going to overwrite it
          metadataKey = existingValue.key
          valueKey = existingValue.valueKey
        } else {
          // Value doesn't already exist
          const id = crypto.randomUUID()
          metadataKey = `${metadataKeyRoot}:${id}`
          valueKey = `${this.#makeBaseValueKey(req)}:${id}`
        }

        /**
         * @type {RedisMetadataValue}
         */
        const metadata = { valueKey }
        if (opts.vary) {
          metadata.vary = JSON.stringify(opts.vary)
        }

        await Promise.all([
          this.#dataClient.hmset(metadataKey, metadata),
          this.#dataClient.set(valueKey, JSON.stringify({
            ...opts,
            rawHeaders: opts.rawHeaders
              ? stringifyBufferArray(opts.rawHeaders)
              : undefined,
            rawTrailers: writable.rawTrailers,
            body: writable.body
          }))
        ])

        // Wait until after we make the keys to set their expiration
        const expireAt = Math.floor(opts.deleteAt / 1000)
        await Promise.all([
          this.#dataClient.expireat(metadataKey, expireAt),
          this.#dataClient.expireat(valueKey, expireAt)
        ])
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
    try {
      await Promise.all([
        this.#dataClient.del(`metadata:${origin}:*`),
        this.#dataClient.del(`values:${origin}:*`)
      ])
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeBaseMetadataKey (req) {
    return `metadata:${req.origin}:${req.path}:${req.method}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeBaseValueKey (req) {
    return `values:${req.origin}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @param {string[]} metadataKeys
   * @returns {Promise<({ key: string } & RedisMetadataValue) | undefined>}
   */
  async #findExistingMetadataValue (req, metadataKeys) {
    // We have multiple values due to the response having a vary header.
    //  Let's find the response that matches
    let value
    for (const key of metadataKeys) {
      const trimmedKey = key.substring(this.#keyPrefix.length)
      const currentValue = await this.#dataCache.hgetall(trimmedKey)

      if (!currentValue.valueKey) {
        // Check if this doesn't exist - shouldn't ever happen but just in cases
        continue
      }

      let matches = true

      if (currentValue.vary) {
        if (!req.headers) {
          continue
        }

        try {
          currentValue.vary = JSON.parse(currentValue.vary)
        } catch (err) {
          this.#dataClient.del(trimmedKey).catch(err => {
            if (this.#errorCallback) {
              this.#errorCallback(err)
            }
          })

          if (this.#errorCallback) {
            this.#errorCallback(err)
          }

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
        value.key = trimmedKey
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
   * @type {Buffer[]} value
   */
  #chunksToSend = []

  /**
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
   * @type {string[] | null}
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

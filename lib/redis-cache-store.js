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
 *
 * @typedef {{
 *  method: string;
 *  url: string;
 * }} Route
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
   * @type {string | undefined}
   */
  #cacheTagsHeader

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

      if (typeof opts.cacheTagsHeader === 'string') {
        this.#cacheTagsHeader = opts.cacheTagsHeader.toLowerCase()
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
   * @returns {Promise<Route[]>}
   */
  async getRoutes () {
    const pattern = `${this.#keyPrefix}metadata:*`
    const metadataKeys = await this.#dataClient.keys(pattern)

    const routes = []
    for (const key of metadataKeys) {
      const { origin, path, method } = this.#parseBaseMetadataKey(key)
      const url = new URL(path, origin).href
      routes.push({ url, method })
    }
    return routes
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

    const metadataValue = await this.#findMetadataValue(req)
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

    const cacheTags = this.#parseCacheTags(opts.rawHeaders)

    let errored = false
    const writable = new RedisStoreWritable(
      this.#maxEntrySize,
      (callback) => {
        if (errored) {
          callback()
          return
        }

        const sendToRedis = async () => {
          let metadataKey
          let valueKey
          let cacheTagsKey

          // Let's check if this response already exists in the cache
          const existingValue = await this.#findMetadataValue(req)
          if (existingValue !== undefined) {
            // Value already exists & we're going to overwrite it
            metadataKey = existingValue.key
            valueKey = existingValue.valueKey

            if (existingValue.cacheTagsKey) {
              cacheTagsKey = existingValue.cacheTagsKey
            }
          } else {
            // Value doesn't already exist
            const id = crypto.randomUUID()
            metadataKey = `${this.#makeBaseMetadataKey(req)}:${id}`
            valueKey = `${this.#makeBaseValueKey(req)}:${id}`

            if (cacheTags.length > 0) {
              cacheTagsKey = `${this.#makeBaseCacheTagKey(req, cacheTags)}:${id}`
            }
          }

          /**
           * @type {RedisMetadataValue}
           */
          const metadata = { valueKey, cacheTagsKey }
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

          if (cacheTagsKey) {
            await this.#dataClient.hmset(cacheTagsKey, { metadataKey, valueKey })
            await this.#dataClient.expireat(cacheTagsKey, expireAt)
          }
        }

        sendToRedis().then(callback).catch(err => {
          if (this.#errorCallback) {
            this.#errorCallback(err)
          }
        })
      }
    )

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
        this.#deleteByPattern(`metadata:${encodeURIComponent(origin)}:*`),
        this.#deleteByPattern(`values:${encodeURIComponent(origin)}:*`),
        this.#deleteByPattern(`cache-tags:${encodeURIComponent(origin)}:*`)
      ])
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {Route[]} routes
   * @returns {Promise<void>}
   */
  async deleteRoutes (routes) {
    const promises = []

    for (const { method, url } of routes) {
      const { origin, pathname, search, hash } = new URL(url)
      const path = pathname + search + hash
      const key = this.#makeBaseMetadataKey({ origin, path, method })

      promises.push(this.#execByPattern(`${key}*`, async (pipeline, keys) => {
        const promises = []

        for (const metadataKey of keys) {
          const promise = this.#dataClient.hgetall(metadataKey)
            .then(({ valueKey, cacheTagsKey }) => {
              pipeline.del(metadataKey)
              pipeline.del(valueKey)
              pipeline.del(cacheTagsKey)
            })

          promises.push(promise)
        }

        await Promise.all(promises)
      }))
    }

    try {
      await Promise.all(promises)
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {string} origin
   * @param {string[]} cacheTags
   * @returns {Promise<void>}
   */
  async deleteByCacheTags (origin, cacheTags) {
    await Promise.all(cacheTags.map(
      tag => this.#deleteByCacheTag(origin, tag))
    )
  }

  /**
   * @param {string} origin
   * @param {string} cacheTag
   * @returns {Promise<void>}
   */
  async #deleteByCacheTag (origin, cacheTag) {
    const encodedOrigin = encodeURIComponent(origin)
    const pattern = `cache-tags:${encodedOrigin}:*${cacheTag}*`

    return this.#execByPattern(pattern, async (pipeline, keys) => {
      const promises = []

      for (const cacheTagsKey of keys) {
        const promise = this.#dataClient.hgetall(cacheTagsKey)
          .then(({ metadataKey, valueKey }) => {
            pipeline.del(metadataKey)
            pipeline.del(valueKey)
            pipeline.del(cacheTagsKey)
          })

        promises.push(promise)
      }

      await Promise.all(promises)
    })
  }

  /**
   * @param {Buffer[]} rawHeaders
   * @returns {string[]}
   */
  #parseCacheTags (rawHeaders) {
    if (!this.#cacheTagsHeader) {
      return []
    }

    for (let i = 0; i < rawHeaders.length; i += 2) {
      const headerName = rawHeaders[i].toString().toLowerCase()
      if (headerName !== this.#cacheTagsHeader) continue

      const headerValue = rawHeaders[i + 1].toString()
      return headerValue.split(',')
    }

    return []
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeBaseMetadataKey (req) {
    const encodedOrigin = encodeURIComponent(req.origin)
    const encodedPath = encodeURIComponent(req.path)
    return `metadata:${encodedOrigin}:${encodedPath}:${req.method}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {string}
   */
  #makeBaseValueKey (req) {
    const encodedOrigin = encodeURIComponent(req.origin)
    return `values:${encodedOrigin}`
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @param {string[]} cacheTags
   * @returns {string}
   */
  #makeBaseCacheTagKey (req, cacheTags) {
    const encodedOrigin = encodeURIComponent(req.origin)
    const tags = cacheTags.join(',')
    return `cache-tags:${encodedOrigin}:${tags}`
  }

  /**
   * @param {string} key
   * @returns {{ origin: string, path: string, method: string, id: string }}
   */
  #parseBaseMetadataKey (key) {
    key = key.replace(this.#keyPrefix, '')

    const keyParts = key.split(':')
    const origin = decodeURIComponent(keyParts[1])
    const path = decodeURIComponent(keyParts[2])
    const method = keyParts[3]
    const id = keyParts[4]

    return { origin, path, method, id }
  }

  /**
   * @param {string} pattern
   * @returns {Promise<void>}
   */
  #deleteByPattern (pattern) {
    return this.#execByPattern(pattern, (pipeline, keys) => {
      for (const key of keys) {
        pipeline.del(key)
      }
    })
  }

  /**
   * @param {string} pattern
   * @param {(pipeline: import('ioredis').Pipeline, keys: string[]) => Promise<void>} callback
   * @returns {Promise<void>}
   */
  #execByPattern (pattern, callback) {
    if (!pattern.startsWith(this.#keyPrefix)) {
      pattern = this.#keyPrefix + pattern
    }

    const stream = this.#dataClient.scanStream({ match: pattern })
    const pipeline = this.#dataClient.pipeline()

    const promises = []

    return new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        keys = keys.map(key => key.replace(this.#keyPrefix, ''))
        promises.push(callback(pipeline, keys))
      })
      stream.on('end', () => {
        Promise.all(promises)
          .then(() => { pipeline.exec(resolve) })
          .catch(reject)
      })
      stream.on('error', reject)
    })
  }

  /**
   * @param {string} pattern
   * @returns {Promise<string[]>}
   */
  #scanKeysByMatch (pattern) {
    return new Promise((resolve, reject) => {
      const stream = this.#dataClient.scanStream({ match: pattern })

      stream.on('error', reject)

      const keys = []
      stream.on('data', chunk => {
        keys.push(...chunk)
      })

      stream.on('close', () => resolve(keys))
    })
  }

  /**
   * @param {import('undici').Dispatcher.RequestOptions} req
   * @returns {Promise<({ key: string } & RedisMetadataValue) | undefined>}
   */
  async #findMetadataValue (req) {
    const keys = await this.#scanKeysByMatch(
      `${this.#keyPrefix}${this.#makeBaseMetadataKey(req)}*`
    )

    for (const key of keys) {
      const trimmedKey = key.substring(this.#keyPrefix.length)
      const currentValue = await this.#dataCache.hgetall(trimmedKey)

      if (!currentValue.valueKey) {
        // Check if this doesn't exist - shouldn't ever happen but just in case
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
        currentValue.key = trimmedKey
        return currentValue
      }
    }

    return undefined
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

  #onFinalCallback

  /**
   * @param {number} maxEntrySize
   * @param {(callback: () => void) => void} onFinalCallback
   */
  constructor (maxEntrySize, onFinalCallback) {
    super()
    this.#maxEntrySize = maxEntrySize
    this.#onFinalCallback = onFinalCallback
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
    this.#onFinalCallback(callback)
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

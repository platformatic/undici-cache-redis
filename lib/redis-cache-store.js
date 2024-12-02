// @ts-check
'use strict'

const { Writable } = require('node:stream')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')

/**
 * @typedef {{
 *  valueKey: string
 *  cacheTags: string
 *  vary?: Record<string, string | string[]> | string
 * }} RedisMetadataValue
 *
 * @typedef {{
 *  key: string
 *  valueKey: string
 *  cacheTags: string[]
 *  vary?: Record<string, string | string[]>
 * }} ParsedRedisMetadataValue
 *
 * @typedef {{
 *  statusCode: number;
 *  statusMessage: string;
 *  headers: Record<string, string | string[]>;
 *  cachedAt: number;
 *  staleAt: number;
 *  deleteAt: number;
 *  body: string[]
 * }} RedisValue
 *
 * @typedef {{
 *  method: string
 *  url: string
 * }} Route
 *
 * @typedef {import('./internal-types.d.ts').CacheStore} CacheStore
 * @implements {CacheStore}
 */
class RedisCacheStore {
  #maxSize = Infinity

  /**
   * @type {((err: Error) => void) | undefined}
   */
  #errorCallback

  /**
   * @type {string | undefined}
   */
  #cacheTagsHeader

  /**
   * The prefix for each key in Redis. Redis usually handles this for us, but
   *  `keys` is an exception in both its input and output (we need to pass in
   *  the full key and we get the full keys back out)
   * @type {string}
   */
  #keyPrefix

  /**
   * @type {import('iovalkey').Redis}
   */
  #redis

  /**
   * @type {TrackingCache | import('iovalkey').Redis}
   */
  #redisCache

  /**
   * @param {import('../index.d.ts').RedisCacheStoreOpts | undefined} opts
   */
  constructor (opts) {
    /**
     * @type {import('iovalkey').RedisOptions | undefined}
     */
    let redisClientOpts

    let tracking = true
    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      if (opts.clientOpts) {
        redisClientOpts = opts.clientOpts
      }

      if (opts.maxSize) {
        if (typeof opts.maxSize !== 'number') {
          throw new TypeError('expected opts.maxSize to be a number')
        }
        this.#maxSize = opts.maxSize
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
    this.#redis = new Redis(redisClientOpts)

    if (tracking) {
      this.#redisCache = new TrackingCache(
        this.#redis,
        new Redis(redisClientOpts),
        this.#errorCallback
      )
    } else {
      this.#redisCache = this.#redis
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    try {
      if (this.#redisCache === this.#redis) {
        await this.#redis.quit()
      } else {
        await Promise.all([this.#redisCache.quit(), this.#redis.quit()])
      }
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<import('./internal-types.d.ts').GetResult | undefined>}
   */
  async get (key) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }

    /**
     * @type {ParsedRedisMetadataValue}
     */
    let metadataValue

    /**
     * @type {string}
     */
    let valueString

    try {
      metadataValue = await this.#findMetadataValue(key)
      if (!metadataValue) {
        // Request isn't cached
        return undefined
      }

      valueString = await this.#redisCache.get(metadataValue.valueKey)
      if (!valueString) {
        // The value expired but the metadata stayed around. This shouldn't ever
        //  happen but is _technically_ possible
        this.#redis.del(metadataValue.key).catch(err => {
          if (this.#errorCallback) {
            this.#errorCallback(err)
          }
        })

        return undefined
      }
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }

      return undefined
    }

    /**
     * @type {RedisValue}
     */
    let value

    try {
      value = JSON.parse(valueString)
    } catch (err) {
      Promise.all([
        this.#redis.del(metadataValue.key),
        this.#redis.del(metadataValue.valueKey)
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

    const result = {
      ...value,
      body: parseBufferArray(value.body)
    }

    if (metadataValue.vary) {
      result.vary = metadataValue.vary
    }

    return result
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {import('./internal-types.d.ts').CachedResponse} value
   * @returns {Writable}
   */
  createWriteStream (key, value) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }

    if (typeof value !== 'object') {
      throw new TypeError(`expected value to be object, got ${typeof value}`)
    }

    let currentSize = 0
    /**
     * @type {string[] | null}
     */
    let body = key.method !== 'HEAD' ? [] : null
    const maxSize = this.#maxSize
    const writeValueToRedis = this.#writeValueToRedis.bind(this)
    const errorCallback = this.#errorCallback

    const writable = new Writable({
      write (chunk, _, callback) {
        if (typeof chunk === 'object') {
          // chunk is a buffer, we need it to be a string
          chunk = chunk.toString()
        }

        currentSize += chunk.length

        if (body) {
          if (currentSize >= maxSize) {
            body = null
            this.end()
            return callback()
          }

          body.push(chunk)
        }

        callback()
      },
      final (callback) {
        if (body) {
          writeValueToRedis(
            key,
            {
              statusCode: value.statusCode,
              statusMessage: value.statusMessage,
              cachedAt: value.cachedAt,
              staleAt: value.staleAt,
              deleteAt: value.deleteAt,
              headers: value.headers,
              body
            },
            value.vary
          ).then(() => {
            callback()
          }).catch(err => {
            if (errorCallback) {
              errorCallback(err)
            }
          })
        } else {
          callback()
        }
      }
    })

    return writable
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   */
  async delete (key) {
    try {
      const encodedOrigin = encodeURIComponent(key.origin)
      const encodedPath = encodeURIComponent(key.path)
      const pattern = `metadata:${encodedOrigin}:${encodedPath}*`

      await this.#execByPattern(pattern, async (pipeline, keys) => {
        const promises = new Array(keys.length)

        for (let i = 0; i < keys.length; i++) {
          promises[i] = this.#deleteByMetadataKey(keys[i])
        }

        await Promise.all(promises)
      })
    } catch (err) {
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey[]} keys
   */
  async deleteKeys (keys) {
    const promises = []

    for (const key of keys) {
      promises.push(this.#deleteByKey(key))
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
   * @param {string[]} cacheTags
   * @returns {Promise<void>}
   */
  async deleteTags (cacheTags) {
    const promises = []

    for (const tag of cacheTags) {
      promises.push(this.#deleteByTag(tag))
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
   * @param {import('./internal-types.d.ts').CacheKey} key
   */
  async #deleteByKey (key) {
    const metadataKey = this.#makeBaseMetadataKey(key)

    await this.#execByPattern(`${metadataKey}*`, async (pipeline, keys) => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        promises[i] = this.#deleteByMetadataKey(keys[i])
      }

      await Promise.all(promises)
    })
  }

  /**
   * @param {string} cacheTag
   * @returns {Promise<void>}
   */
  async #deleteByTag (cacheTag) {
    const pattern = `cache-tags:*${cacheTag}*`

    await this.#execByPattern(pattern, async (pipeline, keys) => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        promises[i] = this.#deleteByCacheTagKey(keys[i])
      }

      await Promise.all(promises)
    })
  }

  /**
   * @param {string} metadataKey
   * @returns {Promise<void>}
   */
  async #deleteByMetadataKey (metadataKey) {
    const metadata = await this.#redis.hgetall(metadataKey)
    if (!metadata.valueKey) return

    const { valueKey, cacheTags } = metadata

    const promises = [
      this.#redis.del(metadataKey),
      this.#redis.del(valueKey)
    ]

    for (const cacheTag of cacheTags.split(',')) {
      promises.push(this.#deleteByTag(cacheTag))
    }

    await Promise.all(promises)
  }

  /**
   * @param {string} cacheTagKey
   * @returns {Promise<void>}
   */
  async #deleteByCacheTagKey (cacheTagKey) {
    const metadata = await this.#redis.hgetall(cacheTagKey)
    if (!metadata.metadataKey) return

    await this.#redis.del(cacheTagKey)
    await this.#deleteByMetadataKey(metadata.metadataKey)
  }

  /**
   * @param {string} pattern
   * @returns {Promise<string[]>}
   */
  #scanKeysByPattern (pattern) {
    // TODO this isn't much better than just `keys`. Ideally we'd we able to
    //  process each stream chunk as we get them so we can quit early if we
    //  find a matching key. However, using the stream for this behavior
    //  gets a bit ugly and unreliable. Converting the stream would be the
    //  preferred method, but it acts really weird when you do that. Need to
    //  look if there's a bug in the Redis library
    return new Promise((resolve, reject) => {
      const stream = this.#redis.scanStream({ match: pattern })

      stream.on('error', reject)

      const keys = []
      stream.on('data', chunk => keys.push(...chunk))

      stream.on('close', () => resolve(keys))
    })
  }

  /**
   * @param {string} pattern
   * @param {(pipeline: import('iovalkey').ChainableCommander, keys: string[]) => void | Promise<void>} callback
   * @returns {Promise<void>}
   */
  #execByPattern (pattern, callback) {
    if (!pattern.startsWith(this.#keyPrefix)) {
      pattern = this.#keyPrefix + pattern
    }

    const stream = this.#redis.scanStream({ match: pattern })
    const pipeline = this.#redis.pipeline()

    const promises = []

    return new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        keys = keys.map(key => key.substring(this.#keyPrefix.length))
        promises.push(callback(pipeline, keys))
      })

      stream.on('end', () => {
        Promise.all(promises)
          .then(() => {
            pipeline.exec((err) => err ? reject(err) : resolve())
          })
          .catch(reject)
      })

      stream.on('error', reject)
    })
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<ParsedRedisMetadataValue | undefined>}
   */
  async #findMetadataValue (key) {
    const metadataKeys = await this.#scanKeysByPattern(
      `${this.#keyPrefix}${this.#makeBaseMetadataKey(key)}*`
    )
    for (const metadataKey of metadataKeys) {
      const trimmedKey = metadataKey.substring(this.#keyPrefix.length)

      /**
       * @type {RedisMetadataValue}
       */
      const currentValue = await this.#redisCache.hgetall(trimmedKey)

      if (!currentValue.valueKey) {
        // Check if this doesn't exist - shouldn't ever happen but just in case
        continue
      }

      let matches = true
      if (currentValue.vary) {
        if (!key.headers) {
          continue
        }

        try {
          currentValue.vary = JSON.parse(currentValue.vary)
        } catch (err) {
          this.#redis.del(trimmedKey).catch(err => {
            if (this.#errorCallback) {
              this.#errorCallback(err)
            }
          })

          if (this.#errorCallback) {
            this.#errorCallback(err)
          }

          continue
        }

        for (const header in currentValue.vary) {
          if (key.headers[header] !== currentValue.vary[header]) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        return {
          key: trimmedKey,
          ...currentValue
        }
      }
    }

    return undefined
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {RedisValue} value
   * @param {Record<string, string | string[]> | undefined} vary
   */
  async #writeValueToRedis (key, value, vary) {
    const existingMetadata = await this.#findMetadataValue(key)
    if (existingMetadata) {
      await this.#deleteByKey(key)
    }

    const reqId = crypto.randomUUID()
    const metadataKey = `${this.#makeBaseMetadataKey(key)}:${reqId}`
    const valueKey = `values:${reqId}`
    const cacheTags = this.#parseCacheTags(value.headers ?? {})

    /**
     * @type {RedisMetadataValue}
     */
    const metadata = { valueKey, cacheTags: cacheTags.join(',') }
    if (vary) {
      metadata.vary = JSON.stringify(vary)
    }

    const pipeline = this.#redis.pipeline()

    pipeline.hmset(metadataKey, metadata)
    pipeline.set(valueKey, JSON.stringify(value))

    const expireAt = Math.floor(value.deleteAt / 1000)
    pipeline.expireat(metadataKey, expireAt)
    pipeline.expireat(valueKey, expireAt)

    for (const cacheTag of cacheTags) {
      const cacheTagsKey = `${this.#makeBaseCacheTagKey(cacheTag)}:${reqId}`
      pipeline.hmset(cacheTagsKey, { metadataKey })
      pipeline.expireat(cacheTagsKey, expireAt)
    }

    await pipeline.exec()
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {string}
   */
  #makeBaseMetadataKey (key) {
    const encodedOrigin = encodeURIComponent(key.origin)
    const encodedPath = encodeURIComponent(key.path)
    return `metadata:${encodedOrigin}:${encodedPath}:${key.method}`
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
   * @param {string} cacheTag
   * @returns {string}
   */
  #makeBaseCacheTagKey (cacheTag) {
    return `cache-tags:${cacheTag}`
  }

  /**
   * @param {Record<string, string | string[]>} headers
   * @returns {string[]}
   */
  #parseCacheTags (headers) {
    if (!this.#cacheTagsHeader) return []

    for (const headerName of Object.keys(headers)) {
      if (headerName.toLowerCase() !== this.#cacheTagsHeader) {
        continue
      }

      const headerValue = headers[headerName]
      return Array.isArray(headerValue) ? headerValue : headerValue.split(',')
    }

    return []
  }
}

/**
 * @param {string[]} strings
 * @returns {Buffer[]}
 */
function parseBufferArray (strings) {
  const output = new Array(strings.length)

  for (let i = 0; i < strings.length; i++) {
    output[i] = Buffer.from(strings[i])
  }

  return output
}

module.exports = RedisCacheStore

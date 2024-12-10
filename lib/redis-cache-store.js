// @ts-check
'use strict'

const { Writable } = require('node:stream')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')
const EventEmitter = require('node:events')

/**
 * @typedef {{
 *  idKey: string
 *  valueKey: string
 *  cacheTags: string
 *  vary?: Record<string, string | string[]> | string
 * }} RedisMetadataValue
 *
 * @typedef {{
 *  key: string
 *  idKey: string
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
class RedisCacheStore extends EventEmitter {
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
   * @type {import('iovalkey').Redis}
   */
  #redisSubscribe

  /**
   * @type {boolean}
   */
  #tracking = true

  /**
   * @type {boolean}
   */
  #subscribed = false

  /**
    * @type {import('iovalkey').RedisOptions}
    */
  #redisClientOpts

  /**
   * @param {import('../index.d.ts').RedisCacheStoreOpts | undefined} opts
   */
  constructor (opts) {
    super()

    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      this.#redisClientOpts = opts.clientOpts ?? {}

      if (opts.maxSize) {
        if (typeof opts.maxSize !== 'number') {
          throw new TypeError('expected opts.maxSize to be a number')
        }
        this.#maxSize = opts.maxSize
      }

      if (opts.tracking === false) {
        this.#tracking = false
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

    this.#keyPrefix = this.#redisClientOpts?.keyPrefix ?? ''
    this.#redis = new Redis({
      enableAutoPipelining: true,
      ...this.#redisClientOpts
    })

    if (this.#tracking) {
      this.#redisCache = new TrackingCache(
        this.#redis,
        new Redis(this.#redisClientOpts),
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
      const promises = [this.#redis.quit()]
      if (this.#tracking) {
        promises.push(this.#redisCache.quit())
      }
      if (this.#subscribed) {
        promises.push(this.#redisSubscribe.quit())
      }
      await Promise.all(promises)
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
     * @type {ParsedRedisMetadataValue | undefined}
     */
    let metadataValue

    /**
     * @type {string | null}
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
      this.#deleteByMetadataKey(metadataValue.key)
        .catch(err => {
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

    if (value.headers.etag) {
      result.etag = value.headers.etag
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
              cacheControlDirectives: value.cacheControlDirectives,
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

      await this.#scanByPattern(pattern, async (keys) => {
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
   * @param {string[]} ids
   * @returns {Promise<void>}
   */
  async deleteIds (ids) {
    const promises = []
    for (const id of ids) {
      promises.push(this.#deleteById(id))
    }
    await Promise.all(promises)
  }

  /**
   * @param {string} id
   * @returns {Promise<string | null>}
   */
  async getValueById (id) {
    const valueKey = `values:${id}`
    return this.#redisCache.get(valueKey)
  }

  async subscribe () {
    if (this.#subscribed) return
    this.#subscribed = true

    try {
      await this.#redis.send_command('CONFIG', [
        'SET', 'notify-keyspace-events', 'AKE'
      ])

      this.#redisSubscribe = new Redis(this.#redisClientOpts)

      await this.#redisSubscribe.subscribe(
        '__keyevent@0__:hset',
        '__keyevent@0__:del',
        '__keyevent@0__:expired'
      )
    } catch (err) {
      this.subscribed = false
      this.#redisSubscribe.quit().catch(err => {
        if (this.#errorCallback) {
          this.#errorCallback(err)
        }
      })
    }

    this.#redisSubscribe.on('message', async (channel, message) => {
      try {
        const keyPrefix = message.slice(0, this.#keyPrefix.length)
        const key = message.slice(this.#keyPrefix.length)

        if (!key.startsWith('ids:')) return
        const id = key.replace('ids:', '')

        // A new cache entry was added
        if (channel === '__keyevent@0__:hset') {
          const { metadataKey } = await this.#redis.hgetall(key)

          const metadata = await this.#redis.hgetall(metadataKey)
          if (!metadata.valueKey) return

          const value = await this.#redis.get(metadata.valueKey)
          if (!value) return

          const parsedMetaKey = this.#parseMetadataKey(metadataKey)
          const parsedValue = JSON.parse(value)

          this.emit('add-entry', {
            id,
            keyPrefix,
            origin: parsedMetaKey.origin,
            path: parsedMetaKey.path,
            method: parsedMetaKey.method,
            statusCode: parsedValue.statusCode,
            headers: parsedValue.headers,
            cachedAt: parsedValue.cachedAt,
            deleteAt: parsedValue.deleteAt
          })

          return
        }

        // A cache entry was deleted
        if (
          channel === '__keyevent@0__:del' ||
          channel === '__keyevent@0__:expired'
        ) {
          this.emit('delete-entry', { id, keyPrefix })
        }
      } catch (err) {
        if (this.#errorCallback) {
          this.#errorCallback(err)
        }
      }
    })
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   */
  async #deleteByKey (key) {
    const metadataKey = this.#makeBaseMetadataKey(key)

    await this.#scanByPattern(`${metadataKey}*`, async (keys) => {
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

    await this.#scanByPattern(pattern, async (keys) => {
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

    const { idKey, valueKey, cacheTags } = metadata

    const promises = [
      this.#redis.del(metadataKey),
      this.#redis.del(idKey),
      this.#redis.del(valueKey)
    ]

    for (const cacheTag of cacheTags.split(',')) {
      promises.push(this.#deleteByTag(cacheTag))
    }

    await Promise.all(promises)
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async #deleteById (id) {
    const { metadataKey } = await this.#redis.hgetall(`ids:${id}`)
    if (!metadataKey) return

    await this.#deleteByMetadataKey(metadataKey)
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
   * @param {(keys: string[]) => void | Promise<void>} callback
   * @param {{ autoPrefix?: boolean }} options
   * @returns {Promise<void>}
   */
  #scanByPattern (pattern, callback, options = {}) {
    const autoPrefix = options.autoPrefix ?? true

    if (autoPrefix && !pattern.startsWith(this.#keyPrefix)) {
      pattern = this.#keyPrefix + pattern
    }

    const stream = this.#redis.scanStream({ match: pattern })
    const promises = []

    return new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        if (autoPrefix) {
          keys = keys.map(key => key.substring(this.#keyPrefix.length))
        }
        promises.push(callback(keys))
      })

      stream.on('end', () => {
        Promise.all(promises)
          .then(() => resolve())
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
    let found = false

    return new Promise((resolve, reject) => {
      this.#scanByPattern(
        `${this.#makeBaseMetadataKey(key)}*`,
        async (metadataKeys) => {
          if (found) return
          for (const metadataKey of metadataKeys) {
            /**
             * @type {RedisMetadataValue}
             */
            const currentValue = await this.#redisCache.hgetall(metadataKey)
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
                this.#redis.del(metadataKey).catch(err => {
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
              found = true
              resolve({ key: metadataKey, ...currentValue })
            }
          }
        }
      )
        .then(() => { if (!found) resolve(undefined) })
        .catch(reject)
    })
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
    const idKey = `ids:${reqId}`
    const valueKey = `values:${reqId}`

    const metadataKey = `${this.#makeBaseMetadataKey(key)}:${reqId}`
    const cacheTags = this.#parseCacheTags(value.headers ?? {})

    /**
     * @type {RedisMetadataValue}
     */
    const metadata = { idKey, valueKey, cacheTags: cacheTags.join(',') }
    if (vary) {
      metadata.vary = JSON.stringify(vary)
    }

    const pipeline = this.#redis.pipeline()

    pipeline.hmset(metadataKey, metadata)
    pipeline.hmset(idKey, { metadataKey })
    pipeline.set(valueKey, JSON.stringify(value))

    const expireAt = Math.floor(value.deleteAt / 1000)
    pipeline.expireat(metadataKey, expireAt)
    pipeline.expireat(idKey, expireAt)
    pipeline.expireat(valueKey, expireAt)

    for (const cacheTag of cacheTags) {
      const cacheTagsKey = `${this.#makeBaseCacheTagKey(cacheTag)}:${reqId}`
      pipeline.hmset(cacheTagsKey, { metadataKey })
      pipeline.expireat(cacheTagsKey, expireAt)
    }

    await pipeline.exec()

    // Needed for test, we want to know when a value is written
    this.emit('write', key, value, vary)
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
  #parseMetadataKey (key) {
    key = key.slice(this.#keyPrefix.length)

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

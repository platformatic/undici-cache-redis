// @ts-check
'use strict'

const EventEmitter = require('node:events')
const { Writable } = require('node:stream')
const { setImmediate } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')

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
 * id: string;
 * keyPrefix: string;
 * origin: string;
 * path: string;
 * method: string;
 * statusCode: number;
 * headers: Record<string, string | string[]>;
 * cachedAt: number;
 * staleAt: number;
 * deleteAt: number;
 * }} CacheEntry
 *
 * @typedef {{
 * redis: import('iovalkey').Redis;
 * abortController: AbortController;
 * keyPrefix: string;
* }} Context
*
 * @typedef {import('./internal-types.d.ts').CacheStore} CacheStore
 * @implements {CacheStore}
 */
class RedisCacheStore extends EventEmitter {
  #maxSize = Infinity

  /**
   * @type {((err: Error) => void)}
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
   * @type {boolean}
   */
  #tracking = true

  /**
   * @type {boolean}
   */
  #closed = false

  /**
    * @type {import('iovalkey').RedisOptions}
    */
  #redisClientOpts

  /**
   * @type {AbortController}
   */
  #abortController

  /**
   * @type {Context}
   */
  #context

  /**
   * @param {import('../index.d.ts').RedisCacheStoreOpts | undefined} opts
   */
  constructor (opts) {
    super()

    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

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
      } else {
        this.#errorCallback = (err) => {
          console.error('Unhandled error in RedisCacheStore:', err)
        }
      }

      if (typeof opts.cacheTagsHeader === 'string') {
        this.#cacheTagsHeader = opts.cacheTagsHeader.toLowerCase()
      }
    }

    const { keyPrefix, ...clientOpts } = opts?.clientOpts ?? {}

    this.#redisClientOpts = clientOpts ?? {}
    this.#keyPrefix = keyPrefix ?? ''

    this.#redis = new Redis({ enableAutoPipelining: true, ...clientOpts })

    if (this.#tracking) {
      this.#redisCache = new TrackingCache(
        this.#redis,
        new Redis(this.#redisClientOpts),
        this.#errorCallback
      )
    } else {
      this.#redisCache = this.#redis
    }

    this.#abortController = new AbortController()

    this.#context = {
      redis: this.#redis,
      abortController: this.#abortController,
      keyPrefix: this.#keyPrefix
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
        this.#redis.del(this.#keyPrefix + metadataValue.key).catch(err => {
          this.#errorCallback(err)
        })

        return undefined
      }
    } catch (err) {
      this.#errorCallback(err)
      return undefined
    }

    /**
     * @type {RedisValue}
     */
    let value

    try {
      value = JSON.parse(valueString)
    } catch (err) {
      deleteByMetadataKey(this.#context, metadataValue.key)
        .catch(err => { this.#errorCallback(err) })

      this.#errorCallback(err)

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
            errorCallback(err)
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
      const pattern = serializeMetadataKey({
        keyPrefix: this.#keyPrefix,
        origin: key.origin,
        path: key.path,
        method: '*',
        id: '*'
      })

      await scanByPattern(this.#context, pattern, async (keys) => {
        const promises = new Array(keys.length)

        for (let i = 0; i < keys.length; i++) {
          promises[i] = deleteByMetadataKey(this.#context, keys[i])
        }

        await Promise.all(promises)
      })
    } catch (err) {
      this.#errorCallback(err)
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
      this.#errorCallback(err)
    }
  }

  /**
   * @param {string[]} cacheTags
   * @returns {Promise<void>}
   */
  async deleteTags (cacheTags) {
    const promises = []

    for (const cacheTag of cacheTags) {
      if (cacheTag) {
        promises.push(deleteByTag(this.#context, cacheTag))
      }
    }

    try {
      await Promise.all(promises)
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    if (this.#closed) return
    this.#closed = true
    this.#abortController.abort()

    // Wait for scan operations abortions
    await setImmediate()

    try {
      const promises = [this.#redis.quit()]
      if (this.#tracking) {
        promises.push(this.#redisCache.quit())
      }
      await Promise.all(promises)
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   */
  async #deleteByKey (key) {
    const pattern = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: '*'
    })

    await scanByPattern(this.#context, pattern, async (keys) => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        promises[i] = deleteByMetadataKey(this.#context, keys[i])
      }

      await Promise.all(promises)
    })
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<ParsedRedisMetadataValue | undefined>}
   */
  async #findMetadataValue (key) {
    let found = false

    const pattern = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: '*'
    })

    return new Promise((resolve, reject) => {
      scanByPattern(
        this.#context,
        pattern,
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
                  this.#errorCallback(err)
                })

                this.#errorCallback(err)

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

    const idKey = serializeIdKey({ keyPrefix: this.#keyPrefix, id: reqId })
    const valueKey = serializeValueKey({ keyPrefix: this.#keyPrefix, id: reqId })
    const metadataKey = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: reqId
    })

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
      const cacheTagsKey = serializeTagKey({
        keyPrefix: this.#keyPrefix,
        tag: cacheTag,
        id: reqId
      })

      pipeline.hmset(cacheTagsKey, { metadataKey })
      pipeline.expireat(cacheTagsKey, expireAt)
    }

    await pipeline.exec()

    // Needed for test, we want to know when a value is written
    this.emit('write', key, value, vary)
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

class RedisCacheManager extends EventEmitter {
  /**
   * @type {import('iovalkey').Redis}
   */
  #redis

  /**
   * @type {import('iovalkey').Redis}
   */
  #redisSubscribe

  /**
   * @type {boolean}
   */
  #subscribed = false

  /**
   * @type {boolean}
   */
  #closed = false

  /**
    * @type {import('iovalkey').RedisOptions}
    */
  #redisClientOpts

  /**
   * @type {AbortController}
   */
  #abortController

  /**
   * @type {Context}
   */
  #context

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
    }

    this.#redis = new Redis({
      enableAutoPipelining: true,
      ...this.#redisClientOpts
    })

    this.#abortController = new AbortController()

    this.#context = {
      redis: this.#redis,
      abortController: this.#abortController,
      keyPrefix: ''
    }
  }

  /**
   * @param {(entry: CacheEntry) => Promise<unknown> | unknown} callback
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async streamEntries (callback, keyPrefix) {
    const context = { ...this.#context, keyPrefix }

    await scanByPattern(context, `${keyPrefix}ids:*`, async (keys) => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        promises[i] = this.#getEntryByIdKey(keys[i])
          .then(entry => { if (entry !== undefined) { callback(entry) } })
      }

      await Promise.all(promises)
    })
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
      await this.#redisSubscribe.quit()

      throw err
    }

    this.#redisSubscribe.on('message', async (channel, idKey) => {
      try {
        if (!idKey.includes('ids:')) return
        const { keyPrefix, id } = parseIdKey(idKey)

        // A new cache entry was added
        if (channel === '__keyevent@0__:hset') {
          const cacheEntry = await this.#getEntryByIdKey(idKey)
          if (cacheEntry !== undefined) {
            this.emit('add-entry', cacheEntry)
          }
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
        this.emit('error', err)
      }
    })
  }

  /**
   * @param {string} id
   * @param {string} keyPrefix
   * @returns {Promise<string | null>}
   */
  async getResponseById (id, keyPrefix) {
    const value = await this.#redis.get(`${keyPrefix}values:${id}`)
    if (!value) return null

    const parsedValue = JSON.parse(value)
    return parsedValue.body.join('')
  }

  /**
   * @param {string[]} ids
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async deleteIds (ids, keyPrefix) {
    const promises = []
    for (const id of ids) {
      promises.push(this.#deleteById(id, keyPrefix))
    }
    await Promise.all(promises)
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    if (this.#closed) return
    this.#closed = true
    this.#abortController.abort()

    // Wait for scan operations abortions
    await setImmediate()

    const promises = [this.#redis.quit()]
    if (this.#subscribed) {
      promises.push(this.#redisSubscribe.quit())
    }
    await Promise.all(promises)
  }

  /**
   * @param {string} idKey
   * @returns {Promise<CacheEntry | undefined>}
   */
  async #getEntryByIdKey (idKey) {
    const { keyPrefix, id } = parseIdKey(idKey)

    const { metadataKey } = await this.#redis.hgetall(idKey)
    if (!metadataKey) return

    const { valueKey } = await this.#redis.hgetall(
      addKeyPrefix(metadataKey, keyPrefix)
    )
    if (!valueKey) return

    const value = await this.#redis.get(
      addKeyPrefix(valueKey, keyPrefix)
    )
    if (!value) return

    const parsedMetaKey = parseMetadataKey(metadataKey)
    const parsedValue = JSON.parse(value)

    return {
      id,
      keyPrefix,
      origin: parsedMetaKey.origin,
      path: parsedMetaKey.path,
      method: parsedMetaKey.method,
      statusCode: parsedValue.statusCode,
      headers: parsedValue.headers,
      cachedAt: parsedValue.cachedAt,
      staleAt: parsedValue.staleAt,
      deleteAt: parsedValue.deleteAt
    }
  }

  /**
   * @param {string} id
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async #deleteById (id, keyPrefix) {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    if (!metadataKey) return

    await deleteByMetadataKey(this.#context, metadataKey)
  }
}

/**
  * @param {Context} ctx
  * @param {string} metadataKey
  * @returns {Promise<void>}
  */
async function deleteByMetadataKey (ctx, metadataKey) {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
  if (!metadata.valueKey) return

  const { idKey, valueKey, cacheTags } = metadata

  const promises = [
    redis.del(addKeyPrefix(metadataKey, keyPrefix)),
    redis.del(addKeyPrefix(idKey, keyPrefix)),
    redis.del(addKeyPrefix(valueKey, keyPrefix))
  ]

  for (const cacheTag of cacheTags.split(',')) {
    if (cacheTag) {
      promises.push(deleteByTag(ctx, cacheTag))
    }
  }

  await Promise.all(promises)
}

/**
  * @param {Context} ctx
  * @param {string} cacheTag
  * @returns {Promise<void>}
  */
async function deleteByTag (ctx, cacheTag) {
  const pattern = `cache-tags:*${cacheTag}*`

  await scanByPattern(ctx, pattern, async (keys) => {
    const promises = new Array(keys.length)
    for (let i = 0; i < keys.length; i++) {
      // TODO: prefix the key ???
      promises[i] = deleteByCacheTagKey(ctx, keys[i])
    }
    await Promise.all(promises)
  })
}

/**
  * @param {Context} ctx
  * @param {string} cacheTagKey
  * @returns {Promise<void>}
  */
async function deleteByCacheTagKey (ctx, cacheTagKey) {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(cacheTagKey, keyPrefix))
  if (!metadata.metadataKey) return

  await redis.del(addKeyPrefix(cacheTagKey, keyPrefix))
  await deleteByMetadataKey(ctx, metadata.metadataKey)
}

/**
 * @param {Context} ctx
 * @param {string} pattern
 * @param {(keys: string[]) => void | Promise<void>} callback
 * @returns {Promise<void>}
 */
function scanByPattern (ctx, pattern, callback) {
  const { redis, keyPrefix, abortController } = ctx

  const stream = redis.scanStream({ match: addKeyPrefix(pattern, keyPrefix) })
  const promises = []

  const abortListener = () => { stream.close() }
  abortController.signal.addEventListener('abort', abortListener)

  return new Promise((resolve, reject) => {
    stream.on('data', (keys) => promises.push(callback(keys)))
    stream.on('end', () => {
      abortController.signal.removeEventListener('abort', abortListener)
      Promise.all(promises).then(() => resolve(), reject)
    })

    stream.on('error', reject)
  })
}

/**
 * @param {string} key
 * @param {string | undefined} prefix
 * @returns {string}
 */
function addKeyPrefix (key, prefix) {
  return prefix && !key.startsWith(prefix) ? prefix + key : key
}

/**
 * @param {{
 *   keyPrefix: string,
 *   origin: string,
 *   path: string,
 *   method: string,
 *   id: string
 * }} parsedKey
 * @returns {string}
 */
function serializeMetadataKey (parsedKey) {
  const { keyPrefix, origin, path, method, id } = parsedKey

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${keyPrefix}metadata:${encodedOrigin}:${encodedPath}:${method}:${id}`
}

/**
 * @param {string} key
 * @returns {{
 *   keyPrefix: string,
 *   origin: string,
 *   path: string,
 *   method: string,
 *   id: string
 * }}
 */
function parseMetadataKey (key) {
  let keyPrefix = ''

  if (!key.startsWith('metadata:')) {
    ([keyPrefix, key] = key.split('metadata:', 2))
  }

  const keyParts = key.split(':')
  const origin = decodeURIComponent(keyParts[0])
  const path = decodeURIComponent(keyParts[1])
  const method = keyParts[2]
  const id = keyParts[3]

  return { keyPrefix, origin, path, method, id }
}

/**
 * @param {{ keyPrefix: string, id: string }} parsedKey
 * @returns {string}
 */
function serializeIdKey (parsedKey) {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}ids:${id}`
}

/**
  * @param {string} key
  * @returns {{ keyPrefix: string, id: string }}
  */
function parseIdKey (key) {
  let keyPrefix = ''

  if (!key.startsWith('ids:')) {
    ([keyPrefix, key] = key.split('ids:', 2))
  }

  return { keyPrefix, id: key }
}

/**
 * @param {{ keyPrefix: string, id: string }} parsedKey
 * @returns {string}
 */
function serializeValueKey (parsedKey) {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}values:${id}`
}

/**
 * @param {{ keyPrefix: string, tag: string, id: string }} parsedKey
 * @returns {string}
 */
function serializeTagKey (parsedKey) {
  const { keyPrefix, tag, id } = parsedKey
  return `${keyPrefix}cache-tags:${tag}:${id}`
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

module.exports = { RedisCacheStore, RedisCacheManager }

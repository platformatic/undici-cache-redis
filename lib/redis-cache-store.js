// @ts-check
'use strict'

const { EventEmitter } = require('node:events')
const { Writable } = require('node:stream')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')
const { indexKey, invalidatedIndexKeys, indexField, entryId, entryKeys } = require('./keys.js')
const { normalizeVary } = require('./vary.js')
const { findBestEntry, writeEntry, deleteByIndex, deleteTags } = require('./entries.js')

/**
 * @typedef {import('./keys.js').IndexEntry} IndexEntry
 *
 * @typedef {{
 *  statusCode: number;
 *  statusMessage: string;
 *  headers: Record<string, string | string[]>;
 *  cachedAt: number;
 *  staleAt: number;
 *  deleteAt: number;
 *  body: string[]
 *  cacheControlDirectives: Record<string, string | string[]>;
 * }} RedisValue
 *
 * @typedef {import('./internal-types.d.ts').CacheStore} CacheStore
 * @implements {CacheStore}
 */
class RedisCacheStore extends EventEmitter {
  #maxEntrySize = Infinity

  /**
   * @type {((err: Error) => void)}
   */
  #errorCallback = (err) => {
    console.error('Unhandled error in RedisCacheStore:', err)
  }

  /**
   * @type {string | undefined}
   */
  #cacheTagsHeader

  /**
   * Prefix added by this library to every key. It is not passed to the client
   * so that keys stored inside values (e.g. `valueKey`) are complete.
   * @type {string}
   */
  #keyPrefix

  /**
   * @type {import('iovalkey').Redis}
   */
  #redis

  #ownsRedis = true

  /**
   * @type {import('iovalkey').Redis | undefined}
   */
  #redisSubscribe

  /**
   * @type {TrackingCache | undefined}
   */
  #trackingCache

  #trackingReady = false

  #closed = false

  /**
   * Writes in flight, awaited by close()
   * @type {Set<Promise<void>>}
   */
  #pendingWrites = new Set()

  /**
   * @type {import('./entries.js').Context}
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

      if (opts.maxEntrySize) {
        if (typeof opts.maxEntrySize !== 'number') {
          throw new TypeError('expected opts.maxEntrySize to be a number')
        }
        this.#maxEntrySize = opts.maxEntrySize
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

    const { keyPrefix, ...clientOpts } = opts?.clientOpts ?? {}
    this.#keyPrefix = keyPrefix ?? ''

    if (opts?.client) {
      this.#redis = opts.client
      this.#ownsRedis = false
    } else {
      this.#redis = new Redis({ enableAutoPipelining: true, ...clientOpts })
    }

    if (opts?.tracking !== false) {
      this.#trackingCache = new TrackingCache({
        maxSize: opts?.maxSize,
        maxCount: opts?.maxCount
      })
      this.#subscribe(this.#trackingCache)
    }

    this.#context = {
      redis: this.#redis,
      trackingCache: this.#trackingCache,
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

    const urlIndexKey = indexKey(this.#keyPrefix, key)
    const tracking = this.#trackingReady ? this.#trackingCache : undefined

    if (tracking) {
      const result = tracking.get(key, urlIndexKey)
      if (result !== undefined) return result
    }

    const version = tracking?.version(urlIndexKey)
    const { entry, value } = await this.#lookup(key, urlIndexKey)

    // Disabling tracking, or invalidating the URL, while the lookup was in
    // flight changes the version, and then the result must not be cached
    if (tracking && version === tracking.version(urlIndexKey) && entry && value) {
      tracking.set({ ...key, id: entry.id }, entry, value, urlIndexKey)
    }

    return value
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<{
   *   metadata: IndexEntry,
   *   value: import('./internal-types.d.ts').GetResult
   * } | undefined>}
   */
  async findCacheByKey (key) {
    const { entry, value } = await this.#lookup(key, indexKey(this.#keyPrefix, key))
    return entry && value ? { metadata: entry, value } : undefined
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {string} urlIndexKey
   * @returns {Promise<{
   *   entry?: IndexEntry,
   *   value?: import('./internal-types.d.ts').GetResult
   * }>}
   */
  async #lookup (key, urlIndexKey) {
    try {
      const entry = findBestEntry(await this.#redis.hgetall(urlIndexKey), key)
      if (!entry) return {}

      // The value can be missing if it was deleted after the index was read
      const value = await this.#redis.get(entryKeys(this.#keyPrefix, entry).value)
      if (!value) return {}

      return { entry, value: createGetResult(JSON.parse(value), entry.vary) }
    } catch (err) {
      this.#errorCallback(err)
      return {}
    }
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
     * @type {string[] | undefined}
     */
    let body = key.method !== 'HEAD' ? [] : undefined
    const maxSize = this.#maxEntrySize
    const pendingWrites = this.#pendingWrites
    const write = this.#write.bind(this)
    const errorCallback = this.#errorCallback

    return new Writable({
      write (chunk, _, callback) {
        if (typeof chunk === 'object') {
          // chunk is a buffer, we need it to be a string
          chunk = chunk.toString('base64')
        }

        currentSize += chunk.length

        if (body) {
          if (currentSize >= maxSize) {
            body = undefined
            this.end()
            return callback()
          }

          body.push(chunk)
        }

        callback()
      },
      final (callback) {
        if (!body) return callback()

        const pending = write(
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
        ).then(() => callback(), (err) => {
          errorCallback(err)
          callback(err)
        }).finally(() => pendingWrites.delete(pending))
        pendingWrites.add(pending)
      }
    })
  }

  /**
   * Deletes every cached response for the origin and path, for all methods.
   * @param {import('./internal-types.d.ts').CacheKey} key
   */
  async delete (key) {
    try {
      await deleteByIndex(this.#context, indexKey(this.#keyPrefix, key))
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey[]} keys
   */
  async deleteKeys (keys) {
    try {
      await Promise.all(keys.map(key =>
        deleteByIndex(this.#context, indexKey(this.#keyPrefix, key), key.method)
      ))
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  /**
   * @param {Array<string | string[]>} tags each item is a tag, or a list of tags that must all match
   * @returns {Promise<void>}
   */
  async deleteTags (tags) {
    try {
      await Promise.all(tags.map(entryTags =>
        deleteTags(this.#context, [entryTags].flat().filter(tag => tag.length > 0))
      ))
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

    try {
      await Promise.all(this.#pendingWrites)
      const promises = []
      if (this.#ownsRedis) {
        promises.push(this.#redis.quit())
      }
      if (this.#redisSubscribe) {
        promises.push(this.#redisSubscribe.quit())
      }
      await Promise.all(promises)
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {RedisValue} value
   * @param {Record<string, string | string[]> | undefined} rawVary
   */
  async #write (key, value, rawVary) {
    const vary = normalizeVary(rawVary)
    if ((vary && '*' in vary) || value.deleteAt <= Date.now()) return

    const field = indexField(key.method, vary)

    /** @type {Omit<IndexEntry, 'writeId'>} */
    const entry = {
      id: key.id ?? entryId(key, field),
      origin: key.origin,
      path: key.path,
      method: key.method,
      field,
      vary,
      tags: this.#parseCacheTags(value.headers ?? {}),
      deleteAt: value.deleteAt
    }

    await writeEntry(this.#context, entry, JSON.stringify(value))

    this.emit('write', {
      id: entry.id,
      origin: key.origin,
      path: key.path,
      method: key.method,
      statusCode: value.statusCode,
      headers: value.headers,
      cacheTags: entry.tags,
      cachedAt: value.cachedAt,
      staleAt: value.staleAt,
      deleteAt: value.deleteAt
    })
  }

  /**
   * Invalidations are redirected to a separate connection. Whenever either
   * connection drops, tracking (and any missed invalidation) is lost, so the
   * local cache is cleared and only trusted again once tracking is restored.
   * @param {TrackingCache} trackingCache
   */
  #subscribe (trackingCache) {
    const redisSubscribe = this.#redis.duplicate({ autoResubscribe: false })
    this.#redisSubscribe = redisSubscribe
    let subscriberId

    const onError = (err) => {
      if (!this.#closed) this.#errorCallback(err)
    }

    const disable = () => {
      this.#trackingReady = false
      trackingCache.clear()
    }

    const redirectTracking = () => {
      disable()
      this.#redis.call('CLIENT', 'TRACKING', 'on', 'REDIRECT', subscriberId)
        .then(() => { this.#trackingReady = !this.#closed }, onError)
    }

    // A reconnected subscriber has a new id, so the redirect is set up again
    redisSubscribe.on('ready', () => {
      disable()
      redisSubscribe.call('CLIENT', 'ID')
        .then(async (id) => {
          subscriberId = String(id)
          await redisSubscribe.subscribe('__redis__:invalidate')
          redirectTracking()
        })
        .catch(onError)
    })
    this.#redis.on('ready', () => { if (subscriberId) redirectTracking() })
    redisSubscribe.on('close', disable)
    this.#redis.on('close', disable)

    // The message lists the invalidated keys, or is empty on a flush
    redisSubscribe.on('message', (_, message) => {
      if (!message) {
        trackingCache.clear()
        return
      }

      for (const urlIndexKey of invalidatedIndexKeys(this.#keyPrefix, message)) {
        trackingCache.deleteGroup(urlIndexKey)
      }
    })
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
      const tags = Array.isArray(headerValue) ? headerValue : headerValue.split(',')
      return tags.filter(tag => tag.length > 0)
    }

    return []
  }
}

/**
 * @param {RedisValue} value
 * @param {Record<string, string | string[] | null> | undefined} vary
 * @returns {import('./internal-types.d.ts').GetResult}
 */
function createGetResult (value, vary) {
  const result = {
    statusCode: value.statusCode,
    statusMessage: value.statusMessage,
    cachedAt: value.cachedAt,
    staleAt: value.staleAt,
    deleteAt: value.deleteAt,
    headers: value.headers,
    body: value.body.map(chunk => Buffer.from(chunk, 'base64'))
  }

  if (value.cacheControlDirectives) {
    result.cacheControlDirectives = value.cacheControlDirectives
  }

  if (value.headers?.etag) {
    result.etag = value.headers.etag
  }

  if (vary) {
    result.vary = vary
  }

  return result
}

module.exports = RedisCacheStore

// @ts-check
'use strict'

const { EventEmitter, setMaxListeners } = require('node:events')
const { Writable } = require('node:stream')
const { setTimeout: sleep } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const TrackingCache = require('./tracking-cache.js')
const {
  addKeyPrefix,
  serializeMetadataKey,
  parseMetadataKey,
  serializeIdKey,
  serializeValueKey,
  serializeTagsKey
} = require('./keys.js')
const { deleteByMetadataKey, deleteTags, scanByPattern } = require('./entries.js')

/**
 * @typedef {{
 *  idKey: string
 *  valueKey: string
 *  tagsKey?: string
 *  vary?: Record<string, string | string[]> | string
 * }} RedisMetadataValue
 *
 * @typedef {{
 *  key: string
 *  idKey: string
 *  valueKey: string
 *  tagsKey?: string
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
 *  cacheControlDirectives: Record<string, string | string[]>;
 * }} RedisValue
 *
 * @typedef {import('./entries.js').Context} Context
 *
 * @typedef {import('./internal-types.d.ts').CacheStore} CacheStore
 * @implements {CacheStore}
 */
class RedisCacheStore extends EventEmitter {
  #maxEntrySize = Infinity

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
   * @type {import('iovalkey').Redis | undefined}
   */
  #redisSubscribe

  /**
   * @type {TrackingCache | undefined}
   */
  #trackingCache

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

    if (!this.#errorCallback) {
      this.#errorCallback = (err) => {
        console.error('Unhandled error in RedisCacheStore:', err)
      }
    }

    const { keyPrefix, ...clientOpts } = opts?.clientOpts ?? {}

    this.#redisClientOpts = clientOpts ?? {}
    this.#keyPrefix = keyPrefix ?? ''

    this.#redis = new Redis({ enableAutoPipelining: true, ...clientOpts })

    if (opts?.tracking !== false) {
      this.#trackingCache = new TrackingCache({
        maxSize: opts?.maxSize,
        maxCount: opts?.maxCount
      })
      this.#subscribe()
    }

    this.#abortController = new AbortController()
    setMaxListeners(100, this.#abortController.signal)

    this.#context = {
      redis: this.#redis,
      trackingCache: this.#trackingCache,
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

    if (this.#trackingCache) {
      const result = this.#trackingCache.get(key)
      if (result !== undefined) return result
    }

    const cacheEntry = await this.findCacheByKey(key)
    if (cacheEntry === undefined) return undefined

    const { metadata, value } = cacheEntry

    if (this.#trackingCache) {
      const parsedMetadataKey = parseMetadataKey(metadata.key)
      this.#trackingCache.set(parsedMetadataKey, metadata, value)
    }

    return value
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<{
   *   metadata: ParsedRedisMetadataValue,
   *   value: import('./internal-types.d.ts').GetResult
   * } | undefined>}
   */
  async findCacheByKey (key) {
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

      valueString = await this.#redis.get(metadataValue.valueKey)
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

    return { metadata: metadataValue, value: result }
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
    const writeValueToRedis = this.#writeValueToRedis.bind(this)
    const errorCallback = this.#errorCallback

    const writable = new Writable({
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
          ).then(() => callback(), (err) => {
            errorCallback(err)
            callback(err)
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
   * @param {Array<string | string[]>} tags
   * @returns {Promise<void>}
   */
  async deleteTags (tags) {
    try {
      const promises = new Array(tags.length)

      for (let i = 0; i < tags.length; i++) {
        let entryTags = tags[i]
        if (!Array.isArray(entryTags)) {
          entryTags = [entryTags]
        }
        promises[i] = deleteTags(this.#context, entryTags)
      }

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

    // Wait for all scan streams to abort
    await sleep(100)

    try {
      const promises = [this.#redis.quit()]
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
    const matchingMetadata = await this.#findMatchingMetadataByKey(key)
    if (matchingMetadata.length === 0) return undefined
    if (matchingMetadata.length === 1) return matchingMetadata[0]

    // Looking for the matching metadata with the most specific vary header
    let bestMatch = matchingMetadata[0]
    let bestMatchVaryCounter = Object.keys(bestMatch.vary ?? {}).length

    for (let i = 1; i < matchingMetadata.length; i++) {
      const matchVary = matchingMetadata[i].vary ?? {}
      const matchVaryCounter = Object.keys(matchVary).length
      if (matchVaryCounter > bestMatchVaryCounter) {
        bestMatch = matchingMetadata[i]
        bestMatchVaryCounter = matchVaryCounter
      }
    }

    return bestMatch
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {Promise<ParsedRedisMetadataValue[]>}
   */
  async #findMatchingMetadataByKey (key) {
    const pattern = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: '*'
    })

    const metadata = []

    await scanByPattern(this.#context, pattern, async (metadataKeys) => {
      for (const metadataKey of metadataKeys) {
        const currentValue = await this.#redis.hgetall(metadataKey)
        if (!currentValue.valueKey || !currentValue.idKey) {
          continue
        }
        if (!currentValue.vary) {
          metadata.push({ key: metadataKey, ...currentValue })
          continue
        }

        try {
          currentValue.vary = JSON.parse(currentValue.vary)
        } catch (err) {
          deleteByMetadataKey(this.#context, metadataKey).catch(err => { this.#errorCallback(err) })
          this.#errorCallback(err)
          continue
        }

        key.headers = key.headers ?? {}
        const matches = Object.entries(currentValue.vary).every(([header, value]) =>
          (key.headers[header] === undefined && value === null) ||
          key.headers[header] === value
        )

        if (matches) {
          metadata.push({ key: metadataKey, ...currentValue })
        }
      }
    })

    return metadata
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {RedisValue} value
   * @param {Record<string, string | string[]> | undefined} vary
   */
  async #writeValueToRedis (key, value, vary) {
    const entryId = key.id ?? crypto.randomUUID()

    const idKey = serializeIdKey({ keyPrefix: this.#keyPrefix, id: entryId })
    const valueKey = serializeValueKey({ keyPrefix: this.#keyPrefix, id: entryId })
    const metadataKey = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: entryId
    })

    /**
     * @type {RedisMetadataValue}
     */
    const metadata = { idKey, valueKey }
    if (vary) {
      metadata.vary = JSON.stringify(vary)
    }

    const expireAt = Math.floor(value.deleteAt / 1000)
    const pipeline = this.#redis.pipeline()

    const tags = this.#parseCacheTags(value.headers ?? {})
    if (tags.length > 0) {
      const tagsKey = serializeTagsKey({ keyPrefix: this.#keyPrefix, tags, id: entryId })
      pipeline.hmset(tagsKey, { metadataKey })
      pipeline.expireat(tagsKey, expireAt)
      metadata.tagsKey = tagsKey
    }

    pipeline.hmset(metadataKey, metadata)
    pipeline.hmset(idKey, { metadataKey })
    pipeline.set(valueKey, JSON.stringify(value))

    pipeline.expireat(metadataKey, expireAt)
    pipeline.expireat(idKey, expireAt)
    pipeline.expireat(valueKey, expireAt)

    // exec() resolves even when commands fail, with an error per command
    const results = await pipeline.exec()
    const failed = results?.find(([err]) => err)
    if (failed) throw failed[0]

    this.emit('write', {
      id: entryId,
      origin: key.origin,
      path: key.path,
      method: key.method,
      statusCode: value.statusCode,
      headers: value.headers,
      cacheTags: tags,
      cachedAt: value.cachedAt,
      staleAt: value.staleAt,
      deleteAt: value.deleteAt
    })

    this.#deleteDuplicates(key, vary).catch(err => this.#errorCallback(err))
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {Record<string, string | string[]> | undefined} vary
   */
  async #deleteDuplicates (key, vary) {
    const matchingMetadata = await this.#findMatchingMetadataByKey(key)

    const varyHeaders = Object.keys(vary ?? {})
    const duplicateMetadata = matchingMetadata.filter(metadata => {
      if (vary === undefined && metadata.vary === undefined) return true
      if (vary === undefined || metadata.vary === undefined) return false

      const duplicateVaryHeaders = Object.keys(metadata.vary)
      if (duplicateVaryHeaders.length !== varyHeaders.length) return false

      for (const header of varyHeaders) {
        if (metadata.vary[header] !== vary[header]) return false
      }

      return true
    })

    if (duplicateMetadata.length > 1) {
      const sortedDuplicates = duplicateMetadata.sort(
        (a, b) => a.key.localeCompare(b.key)
      )
      const promises = sortedDuplicates.slice(1).map(metadata =>
        deleteByMetadataKey(this.#context, metadata.key)
      )
      await Promise.all(promises)
    }
  }

  #subscribe () {
    this.#redisSubscribe = new Redis(this.#redisClientOpts)
    this.#redisSubscribe.call('CLIENT', 'ID')
      .then(clientId => {
        return this.#redis.call('CLIENT', 'TRACKING', 'on', 'REDIRECT', clientId)
      })
      .then(() => this.#redisSubscribe.subscribe('__redis__:invalidate'))
      .catch(err => this.#errorCallback(err))

    this.#redisSubscribe.on('message', (channel, message) => {
      if (channel === '__redis__:invalidate') {
        if (
          message.startsWith('metadata:') ||
          message.startsWith(addKeyPrefix('metadata:', this.#keyPrefix))
        ) {
          const parsedMetadataKey = parseMetadataKey(message)
          if (this.#trackingCache) {
            this.#trackingCache.delete(parsedMetadataKey)
          }
        }
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
    output[i] = Buffer.from(strings[i], 'base64')
  }

  return output
}

module.exports = RedisCacheStore

import { Redis, type RedisOptions } from 'iovalkey'
import { EventEmitter, setMaxListeners } from 'node:events'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import type CacheHandler from 'undici/types/cache-interceptor.js'
import type {
  CacheEntry,
  CacheEntryWithBody,
  CacheKey,
  CacheManager,
  CacheManagerOptions,
  CacheStore,
  CacheStoreOptions
} from '../types.ts'
import { ensureArray, getKeyspaceEventsChannels } from '../utils.ts'
import { TrackingCache, type CachedMetadata } from './tracking-cache.ts'

export interface RedisMetadataValue {
  idKey: string
  valueKey: string
  tagsKey?: string
  vary?: Record<string, string | string[]> | string
}

export interface RedisValue {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
  cachedAt: number
  staleAt: number
  deleteAt: number
  body: string[]
  cacheControlDirectives: CacheHandler.default.CacheControlDirectives
}

export interface ParsedRedisMetadataValue {
  key: string
  idKey: string
  valueKey: string
  tagsKey?: string
  vary?: Record<string, string | string[]>
}

export interface Context<
  Key extends CacheKey = CacheKey,
  Metadata extends Partial<CachedMetadata> = CachedMetadata,
  Result extends Partial<CacheEntryWithBody> = CacheEntryWithBody
> {
  redis: Redis
  trackingCache?: TrackingCache<Key, Metadata, Result> | undefined
  abortController: AbortController
  keyPrefix: string
}

export interface FoundCacheEntry {
  metadata: ParsedRedisMetadataValue
  value: CacheEntryWithBody
}

export class RedisCacheStore extends EventEmitter implements CacheStore {
  #maxEntrySize = Infinity
  #errorCallback: (err: Error) => void
  #cacheTagsHeader: string | undefined
  #keyPrefix: string
  #redis: Redis
  #redisSubscribe: Redis | undefined
  #trackingCache: TrackingCache | undefined
  #closed: boolean
  #redisClientOpts: RedisOptions
  #abortController: AbortController
  #context: Context
  #subscribePromise: Promise<void> | undefined

  constructor (opts: Partial<CacheStoreOptions> | undefined = {}) {
    super()

    this.#closed = false
    /* c8 ignore next 3 */
    this.#errorCallback = err => {
      console.error('Unhandled error in RedisCacheStore:', err)
    }

    if (opts) {
      /* c8 ignore next 3 */
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      /* c8 ignore next 6 */
      if (opts.maxEntrySize) {
        if (typeof opts.maxEntrySize !== 'number') {
          throw new TypeError('expected opts.maxEntrySize to be a number')
        }
        this.#maxEntrySize = opts.maxEntrySize
      }

      if (opts.errorCallback) {
        /* c8 ignore next 3 */
        if (typeof opts.errorCallback !== 'function') {
          throw new TypeError('expected opts.errorCallback to be a function')
        }
        this.#errorCallback = opts.errorCallback
      }

      if (typeof opts.cacheTagsHeader === 'string') {
        this.#cacheTagsHeader = opts.cacheTagsHeader.toLowerCase()
      }
    }

    // This is forbidden in Typescript but still technically possible in Javascript and done in v1
    /* c8 ignore next 3 */
    const { keyPrefix, ...clientOpts } = (opts.clientOpts as RedisOptions) ?? {}
    this.#redisClientOpts = clientOpts ?? {}
    this.#keyPrefix = opts.prefix ?? keyPrefix ?? ''

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

  /* c8 ignore next 3 */
  get version (): string {
    return '1.0.0'
  }

  // This is mostly used for testing
  /* c8 ignore next 3 */
  get client (): Redis {
    return this.#redis
  }

  async get (key: CacheKey): Promise<CacheEntryWithBody | undefined> {
    /* c8 ignore next 3 */
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

  async findCacheByKey (key: CacheKey): Promise<FoundCacheEntry | undefined> {
    let metadataValue: ParsedRedisMetadataValue | undefined
    let valueString: string | null

    try {
      metadataValue = await this.#findMetadataValue(key)
      if (!metadataValue) {
        // Request isn't cached
        return undefined
      }

      valueString = await this.#redis.get(metadataValue.valueKey)

      /* c8 ignore next 9 */
      if (!valueString) {
        // The value expired but the metadata stayed around. This shouldn't ever
        //  happen but is _technically_ possible
        this.#redis.del(this.#keyPrefix + metadataValue.key).catch(err => {
          this.#errorCallback(err)
        })

        return undefined
      }
      /* c8 ignore next 4 */
    } catch (err) {
      this.#errorCallback(err)
      return undefined
    }

    let value: RedisValue

    try {
      value = JSON.parse(valueString)
      /* c8 ignore next 9 */
    } catch (err) {
      deleteByMetadataKey(this.#context, metadataValue.key).catch(err => {
        this.#errorCallback(err)
      })

      this.#errorCallback(err)

      return undefined
    }

    const result = {
      ...value,
      body: parseBufferArray(value.body)
    } as unknown as CacheEntryWithBody

    if (value.headers.etag) {
      result.etag = value.headers.etag as string
    }

    if (metadataValue.vary) {
      result.vary = metadataValue.vary
    }

    return { metadata: metadataValue, value: result }
  }

  createWriteStream (key: CacheKey, value: CacheEntry): Writable {
    /* c8 ignore next 3 */
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }

    /* c8 ignore next 3 */
    if (typeof value !== 'object') {
      throw new TypeError(`expected value to be object, got ${typeof value}`)
    }

    let currentSize = 0
    /* c8 ignore next */
    let body: string[] | undefined = key.method !== 'HEAD' ? [] : undefined
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
          /* c8 ignore next 5 */
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
              headers: value.headers as Record<string, string | string[]>,
              cacheControlDirectives: value.cacheControlDirectives!,
              body
            },
            value.vary as Record<string, string | string[]>
          )
            .then(() => {
              callback()
            })
            /* c8 ignore next 3 */
            .catch(err => {
              errorCallback(err)
            })
          /* c8 ignore next 3 */
        } else {
          callback()
        }
      }
    })

    return writable
  }

  async delete (key: CacheKey): Promise<void> {
    try {
      const pattern = serializeMetadataKey({
        keyPrefix: this.#keyPrefix,
        origin: key.origin,
        path: key.path,
        method: '*',
        id: '*'
      })

      await scanByPattern(this.#context, pattern, async keys => {
        const promises = new Array(keys.length)

        for (let i = 0; i < keys.length; i++) {
          promises[i] = deleteByMetadataKey(this.#context, keys[i])
        }

        await Promise.all(promises)
      })
      /* c8 ignore next 3 */
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  async deleteKeys (keys: CacheKey[]): Promise<void> {
    const promises = []

    for (const key of keys) {
      promises.push(this.#deleteByKey(key))
    }

    try {
      await Promise.all(promises)
      /* c8 ignore next 3 */
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  async deleteTags (tags: Array<string | string[]>): Promise<void> {
    try {
      const promises = new Array(tags.length)

      for (let i = 0; i < tags.length; i++) {
        promises[i] = deleteTags(this.#context, ensureArray(tags[i]))
      }

      await Promise.all(promises)
      /* c8 ignore next 3 */
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  async close (): Promise<void> {
    /* c8 ignore next */
    if (this.#closed) return
    this.#closed = true

    // Clear subscription promise to prevent it from completing
    this.#subscribePromise = undefined

    this.#abortController.abort()

    // Wait for all scan streams to abort
    await sleep(100)

    try {
      // Use quit for main client (graceful) and disconnect for subscribe client (immediate)
      const promises = [this.#redis.quit()]
      if (this.#redisSubscribe) {
        this.#redisSubscribe.disconnect(false)
      }
      await Promise.all(promises)
      /* c8 ignore next 3 */
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  async #deleteByKey (key: CacheKey): Promise<void> {
    const pattern = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: '*'
    })

    await scanByPattern(this.#context, pattern, async keys => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        promises[i] = deleteByMetadataKey(this.#context, keys[i])
      }

      await Promise.all(promises)
    })
  }

  async #findMetadataValue (key: CacheKey): Promise<ParsedRedisMetadataValue | undefined> {
    const matchingMetadata = await this.#findMatchingMetadataByKey(key)
    if (matchingMetadata.length === 0) return undefined
    if (matchingMetadata.length === 1) return matchingMetadata[0]

    // Looking for the matching metadata with the most specific vary header
    /* c8 ignore next 3 */
    let bestMatch = matchingMetadata[0]
    let bestMatchVaryCounter = Object.keys(bestMatch.vary ?? {}).length

    /* c8 ignore next 11 */
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

  async #findMatchingMetadataByKey (key: CacheKey): Promise<ParsedRedisMetadataValue[]> {
    const pattern = serializeMetadataKey({
      keyPrefix: this.#keyPrefix,
      origin: key.origin,
      path: key.path,
      method: key.method,
      id: '*'
    })

    const metadata: ParsedRedisMetadataValue[] = []

    await scanByPattern(this.#context, pattern, async metadataKeys => {
      for (const metadataKey of metadataKeys) {
        const currentValue = (await this.#redis.hgetall(metadataKey)) as unknown as ParsedRedisMetadataValue

        if (!currentValue.valueKey || !currentValue.idKey) {
          continue
        }
        if (!currentValue.vary) {
          currentValue.key ??= metadataKey
          metadata.push(currentValue)
          continue
        }

        try {
          currentValue.vary = JSON.parse(currentValue.vary as unknown as string)
          /* c8 ignore next 7 */
        } catch (err) {
          deleteByMetadataKey(this.#context, metadataKey).catch(err => {
            this.#errorCallback(err)
          })
          this.#errorCallback(err)
          continue
        }

        key.headers ??= key.headers ?? {}
        const matches = Object.entries(currentValue.vary as unknown as string).every(
          ([header, value]) => (key.headers![header] === undefined && value === null) || key.headers![header] === value
        )

        if (matches) {
          currentValue.key ??= metadataKey
          metadata.push(currentValue)
        }
      }
    })

    return metadata
  }

  async #writeValueToRedis (
    key: CacheKey,
    value: RedisValue,
    vary: Record<string, string | string[]> | undefined
  ): Promise<void> {
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

    const metadata: RedisMetadataValue = { idKey, valueKey }
    if (vary) {
      metadata.vary = JSON.stringify(vary)
    }

    const expireAt = Math.floor(value.deleteAt / 1000)
    const pipeline = this.#redis.pipeline()

    /* c8 ignore next */
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

    await pipeline.exec()

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

    try {
      await this.#deleteDuplicates(key, vary)
      /* c8 ignore next 3 */
    } catch (err) {
      this.#errorCallback(err)
    }
  }

  async #deleteDuplicates (key: CacheKey, vary: Record<string, string | string[]> | undefined): Promise<void> {
    const matchingMetadata = await this.#findMatchingMetadataByKey(key)

    const varyHeaders = Object.keys(vary ?? {})
    const duplicateMetadata = matchingMetadata.filter(metadata => {
      if (vary === undefined && metadata.vary === undefined) return true
      if (vary === undefined || metadata.vary === undefined) return false

      const duplicateVaryHeaders = Object.keys(metadata.vary)
      /* c8 ignore next */
      if (duplicateVaryHeaders.length !== varyHeaders.length) return false

      /* c8 ignore next 3 */
      for (const header of varyHeaders) {
        if (metadata.vary[header] !== vary[header]) return false
      }

      return true
    })

    if (duplicateMetadata.length > 1) {
      const sortedDuplicates = duplicateMetadata.sort((a, b) => a.key.localeCompare(b.key))
      const promises = sortedDuplicates.slice(1).map(metadata => deleteByMetadataKey(this.#context, metadata.key))
      await Promise.all(promises)
    }
  }

  #subscribe (): void {
    /* c8 ignore next 3 */
    if (this.#subscribePromise) {
      return
    }

    this.#redisSubscribe = new Redis(this.#redisClientOpts)

    this.#subscribePromise = this.#redisSubscribe
      .call('CLIENT', 'ID')
      .then(clientId => {
        /* c8 ignore next */
        if (this.#closed) return
        return this.#redis.client('TRACKING', 'on', 'REDIRECT', clientId as string)
      })
      .then(() => {
        /* c8 ignore next */
        if (this.#closed) return
        return this.#redisSubscribe!.subscribe('__redis__:invalidate')
      })
      .then(() => {
        this.#subscribePromise = undefined
      })
      /* c8 ignore next 6 */
      .catch(err => {
        this.#subscribePromise = undefined
        if (!this.#closed) {
          this.#errorCallback(err)
        }
      })

    this.#redisSubscribe.on('message', (channel, message) => {
      if (channel === '__redis__:invalidate') {
        if (message.startsWith('metadata:') || message.startsWith(addKeyPrefix('metadata:', this.#keyPrefix))) {
          const parsedMetadataKey = parseMetadataKey(message)
          if (this.#trackingCache) {
            this.#trackingCache.delete(parsedMetadataKey)
          }
        }
      }
    })
  }

  #parseCacheTags (headers: Record<string, string | string[]>): string[] {
    if (!this.#cacheTagsHeader) return []

    for (const headerName of Object.keys(headers)) {
      if (headerName.toLowerCase() !== this.#cacheTagsHeader) {
        continue
      }

      const headerValue = headers[headerName]
      /* c8 ignore next */
      return Array.isArray(headerValue) ? headerValue : headerValue.split(',')
    }

    return []
  }
}

export class RedisCacheManager extends EventEmitter implements CacheManager {
  #redis: Redis
  #redisSubscribe!: Redis
  #subscribed: boolean = false
  #closed: boolean = false
  #redisClientOpts: RedisOptions
  #abortController: AbortController
  #context: Context<CacheKey, RedisValue | ParsedRedisMetadataValue | CachedMetadata, CacheEntryWithBody>
  #clientConfigKeyspaceEventNotify: boolean

  constructor (opts: Partial<CacheManagerOptions> | undefined = {}) {
    super()

    this.#redisClientOpts = {}

    if (opts) {
      /* c8 ignore next 3 */
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      /* c8 ignore next */
      this.#redisClientOpts = opts.clientOpts ?? {}
    }

    if (typeof opts?.clientConfigKeyspaceEventNotify === 'boolean') {
      this.#clientConfigKeyspaceEventNotify = opts.clientConfigKeyspaceEventNotify
    } else {
      this.#clientConfigKeyspaceEventNotify = true
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

  /* c8 ignore next 3 */
  get version (): string {
    return '1.0.0'
  }

  /* c8 ignore next 3 */
  get client (): Redis {
    return this.#redis
  }

  async streamEntries (
    callback: (entry: CacheEntry) => Promise<unknown> | unknown,
    keyPrefix: string | string[] = ''
  ): Promise<void> {
    for (const prefix of ensureArray(keyPrefix)) {
      const context = { ...this.#context, keyPrefix: prefix }

      await scanByPattern(context, `${prefix}ids:*`, async keys => {
        const promises = new Array(keys.length)

        for (let i = 0; i < keys.length; i++) {
          const { keyPrefix } = parseIdKey(keys[i])
          promises[i] = this.#getEntryByIdKey(keys[i], keyPrefix).then(entry => {
            if (entry !== undefined) {
              callback(entry)
            }
          })
        }

        await Promise.all(promises)
      })
    }
  }

  async subscribe (): Promise<void> {
    /* c8 ignore next */
    if (this.#subscribed) return
    this.#subscribed = true

    const channels = getKeyspaceEventsChannels(this.#redisClientOpts, 'hset', 'del', 'expired')

    try {
      this.#redisSubscribe = new Redis(this.#redisClientOpts)

      if (this.#clientConfigKeyspaceEventNotify) {
        await this.#redisSubscribe.config('SET', 'notify-keyspace-events', 'AKE')
      }

      await this.#redisSubscribe.subscribe(...Object.values(channels))
      /* c8 ignore next 6 */
    } catch (err) {
      this.#subscribed = false
      await this.#redisSubscribe.quit()

      throw err
    }

    this.#redisSubscribe.on('message', async (channel, key) => {
      try {
        if (key.includes('ids:')) {
          const { keyPrefix, id } = parseIdKey(key)

          // A new cache entry was added
          if (channel === channels.hset) {
            const cacheEntry = await this.#getEntryByIdKey(key, keyPrefix)
            if (cacheEntry !== undefined) {
              this.emit('add-entry', cacheEntry)
            }
            return
          }

          // A cache entry was deleted
          if (channel === channels.del || channel === channels.expired) {
            this.emit('delete-entry', { id, keyPrefix })
          }
          return
        }

        if (key.includes('cache-tags:')) {
          const { tags } = parseTagsKey(key)

          // A cache entry was deleted by tag
          if (channel === channels.del || channel === channels.expired) {
            await deleteTags(this.#context, tags, { global: true })
          }
        }
        /* c8 ignore next 3 */
      } catch (err) {
        this.emit('error', err)
      }
    })
  }

  async getResponseById (id: string, keyPrefix: string = ''): Promise<string | null> {
    const value = await this.#redis.get(`${keyPrefix}values:${id}`)
    /* c8 ignore next */
    if (!value) return null

    const parsedValue = JSON.parse(value)
    const base64Body = parsedValue.body.join('')

    return Buffer.from(base64Body, 'base64').toString('utf8')
  }

  async getDependentEntries (id: string, keyPrefix: string = ''): Promise<CacheEntry[]> {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    /* c8 ignore next */
    if (!metadataKey) return []

    const { tagsKey } = await this.#redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
    /* c8 ignore next */
    if (!tagsKey) return []

    const { tags } = parseTagsKey(tagsKey)
    /* c8 ignore next */
    if (tags.length === 0) return []

    const entries: CacheEntry[] = []
    const pattern = `*cache-tags:*${tags.sort().join('*:*')}:*`

    const fullTagsKey = addKeyPrefix(tagsKey, keyPrefix)

    await scanByPattern(this.#context, pattern, async keys => {
      const promises = new Array(keys.length)
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === fullTagsKey) continue

        const { keyPrefix } = parseTagsKey(keys[i])
        promises[i] = this.#getEntryByTagsKey(keys[i], keyPrefix).then(entry => {
          if (entry !== undefined) entries.push(entry)
        })
      }
      await Promise.all(promises)
    })

    return entries
  }

  async deleteIds (ids: string[], keyPrefix: string = ''): Promise<void> {
    const promises = []
    for (const id of ids) {
      promises.push(this.#deleteById(id, keyPrefix))
    }
    await Promise.all(promises)
  }

  async close (): Promise<void> {
    /* c8 ignore next */
    if (this.#closed) return
    this.#closed = true
    this.#abortController.abort()

    // Wait for scan operations abortions
    await sleep(100)

    const promises = [this.#redis.quit()]
    if (this.#subscribed) {
      promises.push(this.#redisSubscribe.quit())
    }
    await Promise.all(promises)
  }

  async #getEntryByIdKey (idKey: string, keyPrefix: string = ''): Promise<CacheEntry | undefined> {
    const { metadataKey } = await this.#redis.hgetall(addKeyPrefix(idKey, keyPrefix))
    /* c8 ignore next */
    if (!metadataKey) return

    return this.#getEntryByMetadataKey(metadataKey, keyPrefix)
  }

  async #getEntryByTagsKey (tagsKey: string, keyPrefix: string = ''): Promise<CacheEntry | undefined> {
    const { metadataKey } = await this.#redis.hgetall(addKeyPrefix(tagsKey, keyPrefix))
    /* c8 ignore next */
    if (!metadataKey) return

    return this.#getEntryByMetadataKey(metadataKey, keyPrefix)
  }

  async #getEntryByMetadataKey (metadataKey: string, keyPrefix: string = ''): Promise<CacheEntry | undefined> {
    const { id } = parseMetadataKey(metadataKey)

    const { valueKey, tagsKey } = await this.#redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
    /* c8 ignore next */
    if (!valueKey) return

    const value = await this.#redis.get(addKeyPrefix(valueKey, keyPrefix))
    /* c8 ignore next */
    if (!value) return

    const parsedMetaKey = parseMetadataKey(metadataKey)
    const parsedValue = JSON.parse(value)

    let cacheTags: string[] = []
    if (tagsKey) {
      const { tags } = parseTagsKey(tagsKey)
      cacheTags = tags
    }

    return {
      id,
      keyPrefix,
      origin: parsedMetaKey.origin,
      path: parsedMetaKey.path,
      method: parsedMetaKey.method,
      statusCode: parsedValue.statusCode,
      statusMessage: parsedValue.statusMessage,
      headers: parsedValue.headers,
      cacheTags,
      cachedAt: parsedValue.cachedAt,
      staleAt: parsedValue.staleAt,
      deleteAt: parsedValue.deleteAt
    }
  }

  async #deleteById (id: string, keyPrefix: string = ''): Promise<void> {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    /* c8 ignore next */
    if (!metadataKey) return

    await deleteByMetadataKey(this.#context, metadataKey)
  }
}

async function deleteByMetadataKey (ctx: Context, metadataKey: string): Promise<void> {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
  if (!metadata.valueKey) return

  const { idKey, valueKey, tagsKey } = metadata

  const promises: Promise<number | void>[] = [
    redis.del(addKeyPrefix(metadataKey, keyPrefix)),
    redis.del(addKeyPrefix(idKey, keyPrefix)),
    redis.del(addKeyPrefix(valueKey, keyPrefix))
  ]

  if (ctx.trackingCache) {
    ctx.trackingCache.delete(parseMetadataKey(metadataKey))
  }

  if (tagsKey) {
    const { tags } = parseTagsKey(tagsKey)
    promises.push(redis.del(addKeyPrefix(tagsKey, keyPrefix)))
    promises.push(deleteTags(ctx, tags))
  }

  await Promise.all(promises)
}

async function deleteTags (ctx: Context, tags: string[], opts: { global?: boolean } = {}): Promise<void> {
  tags = tags.filter(tag => tag.length > 0)
  /* c8 ignore next */
  if (tags.length === 0) return

  const global = opts.global ?? false
  const prefix = global ? '*' : ''
  const pattern = `${prefix}cache-tags:*${tags.sort().join('*:*')}:*`

  await scanByPattern(ctx, pattern, async keys => {
    const promises = new Array(keys.length)
    for (let i = 0; i < keys.length; i++) {
      const { keyPrefix } = parseTagsKey(keys[i])
      const context = { ...ctx, keyPrefix }
      promises[i] = deleteByTagKey(context, keys[i])
    }
    await Promise.all(promises)
  })
}

async function deleteByTagKey (ctx: Context, tagKey: string): Promise<void> {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(tagKey, keyPrefix))
  /* c8 ignore next */
  if (!metadata.metadataKey) return

  await redis.del(addKeyPrefix(tagKey, keyPrefix))
  await deleteByMetadataKey(ctx, metadata.metadataKey)
}

export async function scanByPattern (
  ctx: Context,
  pattern: string,
  callback: (keys: string[]) => Promise<void>
): Promise<void> {
  const { redis, keyPrefix, abortController } = ctx

  const promises: Promise<void | Error>[] = []
  let cursor = '0'

  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', addKeyPrefix(pattern, keyPrefix), 'COUNT', '1000')
      if (keys.length > 0) promises.push(callback(keys).catch(err => err))
      cursor = nextCursor
    } while (cursor !== '0' && !abortController.signal.aborted)
  } finally {
    await Promise.allSettled(promises).then(results => {
      const errors = results
        .filter(value => value.status === 'fulfilled' && value.value instanceof Error)
        .map(value => (value as PromiseRejectedResult).reason)
      if (errors.length > 0) {
        throw new Error('Error(s) occurred during scanByPattern operation', { cause: errors })
      }
    })
  }
}

function addKeyPrefix (key: string, prefix: string | undefined): string {
  return prefix && !key.startsWith(prefix) ? prefix + key : key
}

function serializeMetadataKey (parsedKey: {
  keyPrefix: string
  origin: string
  path: string
  method: string
  id: string
}): string {
  const { keyPrefix, origin, path, method, id } = parsedKey

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${keyPrefix}metadata:${encodedOrigin}:${encodedPath}:${method}:${id}`
}

function parseMetadataKey (key: string): {
  keyPrefix: string
  origin: string
  path: string
  method: string
  id: string
} {
  const typePrefix = 'metadata:'
  const splitIndex = key.indexOf(typePrefix)

  /* c8 ignore next 3 */
  if (splitIndex === -1) {
    throw new Error(`Invalid cache metadata key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  key = key.slice(splitIndex + typePrefix.length)

  const parts = key.split(':')
  const origin = decodeURIComponent(parts[0])
  const path = decodeURIComponent(parts[1])
  const method = parts[2]
  const id = parts[3]

  return { keyPrefix, origin, path, method, id }
}

function serializeIdKey (parsedKey: { keyPrefix: string; id: string }): string {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}ids:${id}`
}

function parseIdKey (key: string): { keyPrefix: string; id: string } {
  const typePrefix = 'ids:'
  const splitIndex = key.indexOf(typePrefix)

  /* c8 ignore next 3 */
  if (splitIndex === -1) {
    throw new Error(`Invalid cache id key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  const id = key.slice(splitIndex + typePrefix.length)

  return { keyPrefix, id }
}

function serializeValueKey (parsedKey: { keyPrefix: string; id: string }): string {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}values:${id}`
}

function serializeTagsKey (parsedKey: { keyPrefix: string; tags: string[]; id: string }): string {
  const { keyPrefix, tags, id } = parsedKey
  return `${keyPrefix}cache-tags:${tags.sort().join(':')}:${id}`
}

function parseTagsKey (key: string): { keyPrefix: string; tags: string[]; id: string } {
  const typePrefix = 'cache-tags:'
  const splitIndex = key.indexOf(typePrefix)

  /* c8 ignore next 3 */
  if (splitIndex === -1) {
    throw new Error(`Invalid cache tags key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  key = key.slice(splitIndex + typePrefix.length)

  const parts = key.split(':')
  const tags = parts.slice(0, -1)
  const id = parts[parts.length - 1]

  return { keyPrefix, tags, id }
}

function parseBufferArray (strings: string[]): Buffer[] {
  const output = new Array(strings.length)

  for (let i = 0; i < strings.length; i++) {
    output[i] = Buffer.from(strings[i], 'base64')
  }

  return output
}

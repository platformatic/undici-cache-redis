import hyperid from 'hyperid'
import { Redis, type RedisOptions } from 'iovalkey'
import EventEmitter, { once } from 'node:events'
import { Writable } from 'node:stream'
import pMap from 'p-map'
import xxhash, { type XXHashAPI } from 'xxhash-wasm'
import type {
  CacheEntry,
  CacheEntryWithBody,
  CacheKey,
  CacheManager,
  CacheManagerOptions,
  CacheStore
} from '../types.ts'
import { ensureArray, getKeyspaceEventsChannels } from '../utils.ts'
import { InvalidOptionError, MaxEntrySizeExceededError, UserError } from './errors.ts'
import { TrackingCache } from './tracking-cache.ts'
import type { CacheIdentifier, CacheMetadata, CleanupTask, Keys, VariantsIterationResultCallback } from './types.ts'
import { decodeBody, KeysStorage, replaceKeyPlaceholder, serializeHeaders, varyMatches } from './utils.ts'

export const defaultOptions: Partial<CacheManagerOptions> = {
  maxEntrySize: 10 * 1024 * 1024, // 10 MB
  maxBatchSize: 100,
  concurrency: 10
}

/*
  Data architecture:
    SORTED SET prefix:routes
      VALUE: origin + path
      SCORE: 0

    SORTED SET prefix:tags
      VALUE: hash
      SCORE: 0

    SORTED SET prefix:tag|tagName
      VALUE: id
      SCORE: 0

    SORTED SET prefix:requests|origin|path
      VALUE: method
      SCORE: 0

    SORTED SET prefix:request|origin|path|method
      VALUE: { score, id, specificity, hash, vary, tags, expireAt } (score is padded for lexicographical ordering)
      SCORE: 0

    SORTED prefix:variants|origin|path|method
      VALUE: hash
      SCORE: updatedAt

    STRING prefix:metadata:id = metadata
    STRING prefix:body:id = body

  All sorted sets are autocleaning: when traversing, expired entries are removed automatically.
  Also, all sets use 0 as score since we only score by lexicographical order.
*/
export class Cache extends EventEmitter implements CacheStore, CacheManager {
  #options: CacheManagerOptions
  #maxBatchSize: number
  #maxEntrySize: number
  #concurrency: number
  #errorCallback: (err: Error) => void
  #cacheTagsHeader: string | undefined
  #prefix: string
  #primaryClient: Redis
  #secondaryClient: Redis | undefined
  #subscriptionClient: Redis | undefined
  #subscribed: boolean
  #clientOptions: RedisOptions
  #generateId: hyperid.Instance
  #keys: KeysStorage
  #closed: boolean
  #xxhash: XXHashAPI | undefined
  #cleanupQueue: CleanupTask[]
  #cleaningScheduled: boolean
  #cleaningInProgress: boolean
  #trackingCache: TrackingCache | undefined

  constructor (userOptions: Partial<CacheManagerOptions> = {}) {
    super()

    const options = { ...defaultOptions, ...userOptions }

    /* c8 ignore next 3 */
    if (typeof options.maxEntrySize !== 'number') {
      throw new InvalidOptionError('maxEntrySize must be a number')
    }

    /* c8 ignore next 3 */
    if (typeof options.maxBatchSize !== 'number') {
      throw new InvalidOptionError('maxBatchSize must be a number')
    }

    /* c8 ignore next 3 */
    if (options.errorCallback && typeof options.errorCallback !== 'function') {
      throw new InvalidOptionError('errorCallback must be a function')
    }

    // This is forbidden in Typescript but still technically possible in Javascript and done in v1
    /* c8 ignore next */
    const { keyPrefix, ...clientOpts } = (options.clientOpts as RedisOptions) ?? {}

    this.#options = options
    this.#prefix = options.prefix ?? keyPrefix ?? ''
    this.#clientOptions = { enableAutoPipelining: true, ...clientOpts }
    this.#primaryClient = new Redis(this.#clientOptions)
    this.#closed = false
    this.#subscribed = false
    this.#generateId = hyperid()
    this.#maxEntrySize = options.maxEntrySize!
    this.#maxBatchSize = options.maxBatchSize!
    this.#keys = new KeysStorage()
    this.#concurrency = options.concurrency!
    this.#cacheTagsHeader = options.cacheTagsHeader?.toLowerCase()
    this.#errorCallback = options.errorCallback ?? ((_: Error) => {})
    this.#cleanupQueue = []
    this.#cleaningScheduled = false
    this.#cleaningInProgress = false

    if (options.tracking) {
      this.#trackingCache = new TrackingCache({ maxSize: options.maxSize, maxCount: options.maxCount })
      this.#trackingSubscribeInvalidations(this.#prefix).catch(err => this.#errorCallback(err))
    }
  }

  /* c8 ignore next 3 */
  get version (): string {
    return '2.0.0'
  }

  /* c8 ignore next 3 */
  get prefix (): string {
    return this.#prefix
  }

  // This is mostly used for testing
  /* c8 ignore next 4 */
  get client (): Redis {
    this.#secondaryClient ??= new Redis(this.#clientOptions)
    return this.#secondaryClient
  }

  // This is mostly used for testing
  /* c8 ignore next 3 */
  get tracking (): TrackingCache | undefined {
    return this.#trackingCache
  }

  // Uncomment this method for debugging - Do not remove it
  // emit (name: string, ...args: any[]): boolean {
  //   // @ts-expect-error Not officially exported by node
  //   process._rawDebug(`Emitting event: ${name}`, ...args)
  //   return super.emit(name, ...args)
  // }

  async close (): Promise<void> {
    if (this.#closed) {
      return
    }

    if (this.#secondaryClient) {
      if (!this.#cleaningInProgress && !this.#cleaningScheduled) {
        this.#scheduleCleanup()
      }

      await once(this, 'cleanup:complete')
    }

    this.#closed = true
    this.#cleanupQueue = []

    await this.#secondaryClient?.disconnect()
    await this.#closeClient(this.#primaryClient)
    await this.#closeClient(this.#secondaryClient)
    await this.#closeClient(this.#subscriptionClient)
  }

  async get (key: CacheKey, prefixes?: string | string[]): Promise<CacheEntryWithBody | undefined>
  async get (
    key: CacheKey,
    prefixes: string | string[] | undefined,
    includeBody: false
  ): Promise<CacheEntry | undefined>
  async get (
    key: CacheKey,
    prefixes: string | string[] | undefined = undefined,
    includeBody: boolean = true
  ): Promise<CacheEntry | CacheEntryWithBody | undefined> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      return undefined
    }

    let keys!: Keys
    let prefix: string | undefined
    let id: string | undefined
    let headers: Record<string, string> | undefined

    prefixes = this.#normalizePrefixes(prefixes)

    if (this.#trackingCache) {
      const trackedEntry = this.#trackingCache.get(key, prefixes)

      if (trackedEntry) {
        /* c8 ignore next 3 */
        if (!includeBody) {
          delete trackedEntry.body
        }

        return trackedEntry
      }
    }

    // Search on each prefix
    for (prefix of prefixes) {
      keys = this.#keys.get(key, prefix)
      headers = serializeHeaders(key.headers)

      // Start iterating the sorted set for the requests
      const now = Date.now() / 1000

      id = await this.#iterateVariants<string>(keys.request, prefix, async (raw: string) => {
        const entry = JSON.parse(raw) as CacheIdentifier

        // The member has expired, autoclean
        /* c8 ignore next 3 */
        if (entry.expireAt < now) {
          return { expired: true }
        }

        if (varyMatches(entry, headers!)) {
          return { value: entry.id }
        }
      })

      if (id) {
        break
      }
    }

    if (!id) {
      return undefined
    }

    let contents: (string | null)[]

    if (includeBody) {
      // There is a key, get the metadata and body
      contents = await this.#primaryClient.mget(
        replaceKeyPlaceholder(keys.metadata, id),
        replaceKeyPlaceholder(keys.body, id)
      )
    } else {
      contents = [await this.#primaryClient.get(replaceKeyPlaceholder(keys.metadata, id))]
    }

    const metadata = JSON.parse(contents[0]!) as CacheMetadata
    const entry: CacheEntry | CacheEntryWithBody = metadata.entry

    entry.cacheTags = metadata.identifier.tags

    const entryWithBody: CacheEntryWithBody = entry as CacheEntryWithBody
    if (includeBody) {
      // Deserialize space separated base64 body chunks
      entryWithBody.body = decodeBody(contents[1]!)
    }

    if (this.#trackingCache) {
      this.#trackingCache.set(keys, metadata)
      this.emit('tracking:add', { prefix, origin: key.origin, path: key.path, method: key.method, headers })
    }

    return entry
  }

  /* c8 ignore next 4 */
  async getKeys (keys: Iterable<CacheKey>, prefixes?: string | string[]): Promise<CacheEntryWithBody[]> {
    const results = await pMap(keys, key => this.get(key, prefixes), { concurrency: this.#concurrency })
    return results.filter(entry => entry) as CacheEntryWithBody[]
  }

  async getTag (tag: string, prefixes?: string | string[]): Promise<CacheEntry[]> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    const entries: CacheEntry[] = []

    await pMap(
      this.#normalizePrefixes(prefixes),
      async keyPrefix => {
        const keys = this.#keys.get({}, keyPrefix)
        const tagKey = `${keys.tags}|${tag}`

        // Do not use #iterateVariants since we need to get entries in batch as well
        let offset = 0
        while (true) {
          const ids = await this.#primaryClient.zrange(
            tagKey,
            '+',
            '-',
            'BYLEX',
            'REV',
            'LIMIT',
            offset,
            this.#maxBatchSize
          )

          if (ids.length === 0) {
            break
          }

          offset += ids.length
          const membersData = await this.#primaryClient.mget(...ids.map(id => replaceKeyPlaceholder(keys.metadata, id)))

          const keysBatch = new Set<CacheKey>()
          for (const member of membersData) {
            /* c8 ignore next 3 */
            if (!member) {
              continue
            }

            const { id, origin, method, path } = JSON.parse(member).entry as CacheEntry
            keysBatch.add({ id, origin, method, path })
          }

          const batch = await pMap(keysBatch, key => this.get(key, keyPrefix, false), {
            concurrency: this.#concurrency
          })
          entries.push(...(batch.filter(entry => entry) as CacheEntry[]))
        }
      },
      { concurrency: this.#concurrency }
    )

    return entries
  }

  /* c8 ignore next 6 */
  async getTags (tags: Array<string | string[]>, prefixes?: string | string[]): Promise<CacheEntry[]> {
    const entries = await pMap(new Set(tags.flat(1)), tag => this.getTag(tag, prefixes), {
      concurrency: this.#concurrency
    })
    return entries.flat(1)
  }

  async getResponseById (id: string, prefixes?: string | string[]): Promise<string | null> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    for (const prefix of this.#normalizePrefixes(prefixes)) {
      const keys = this.#keys.get({ id }, prefix)

      const contents = await this.#primaryClient.mget(keys.metadata, keys.body)

      /* c8 ignore next 3 */
      if (!contents || contents.length < 2) {
        continue
      }

      const {
        identifier: { expireAt }
      } = JSON.parse(contents[0]!) as CacheMetadata

      /* c8 ignore next 3 */
      if (expireAt < Date.now() / 1000) {
        continue
      }

      return decodeBody(contents[1]!)
        .map(buf => buf.toString())
        .join('')
    }
    /* c8 ignore next 3 */

    return null
  }

  async getDependentEntries (id: string, prefixes?: string | string[]): Promise<CacheEntry[]> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    prefixes = this.#normalizePrefixes(prefixes)

    const dependentEntries: Map<string, CacheEntry> = new Map()
    let metadata: string | null = null

    for (const prefix of prefixes) {
      const keys = this.#keys.get({ id }, prefix)
      metadata = await this.#primaryClient.get(keys.metadata)

      if (metadata) {
        break
      }
    }

    /* c8 ignore next 3 */
    if (!metadata) {
      return []
    }

    const {
      identifier: { tags, expireAt }
    } = JSON.parse(metadata) as CacheMetadata

    /* c8 ignore next 3 */
    if (expireAt < Date.now() / 1000) {
      return []
    }

    // Search in each prefix
    await pMap(
      prefixes,
      async prefix => {
        // Search each tag
        await pMap(
          tags,
          async tag => {
            const entries = await this.getTag(tag, prefix)

            for (const entry of entries) {
              if (entry.id !== id && this.#areTagsDependent(tags, entry.cacheTags)) {
                dependentEntries.set(entry.keyPrefix + '|' + entry.id, entry)
              }
            }
          },
          { concurrency: this.#concurrency }
        )
      },
      { concurrency: this.#concurrency }
    )

    return Array.from(dependentEntries.values())
  }

  createWriteStream (key: CacheKey, value: CacheEntry): Writable {
    const maxSize = this.#maxEntrySize
    const writeData = this.#writeData.bind(this)
    const errorCallback = this.#errorCallback.bind(this)

    let body = ''
    let aborted = false

    return new Writable({
      write (chunk, encoding, callback) {
        // Serialize buffers or strings as base64, separated by space.
        // This avoids using JSON when deserializing. Space is a safe separator since
        // base64 does not use it.
        /* c8 ignore next */
        body += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).toString('base64') + ' '

        // The body is too big, abort
        /* c8 ignore next 5 */
        if (body.length >= maxSize) {
          aborted = true
          this.destroy(new MaxEntrySizeExceededError('Max entry size exceeded'))
          return
        }

        callback()
      },
      final (callback) {
        /* c8 ignore next 4 */
        if (aborted) {
          callback()
          return
        }

        writeData(key, value, body.trim())
          .then(() => {
            setImmediate(() => {
              callback()
            })
          })
          /* c8 ignore next 5 */
          .catch((err: Error) => {
            setImmediate(() => {
              errorCallback(err)
              callback(err)
            })
          })
      }
    })
  }

  async delete (key: CacheKey, prefixes?: string | string[]): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      return
    }

    for (const prefix of this.#normalizePrefixes(prefixes)) {
      const { requests } = this.#keys.get(key, prefix)

      // No need to paginate here since the number of methods per key should be limited
      const methods = await this.#primaryClient.zrange(requests, '+', '-', 'BYLEX', 'REV')
      await pMap(methods, method => this.deleteKeys([{ ...key, method }], prefix), { concurrency: this.#concurrency })
    }
  }

  async deleteKeys (keys: Iterable<CacheKey>, prefixes?: string | string[]): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    const now = Date.now() / 1000
    const map = new Map<string, CacheKey>()

    // Avoid duplicates
    for (const key of keys) {
      map.set(`${key.origin}|${key.path}|${key.method}`, key)
    }

    for (const prefix of this.#normalizePrefixes(prefixes)) {
      await pMap(
        map.values(),
        async key => {
          const keys = this.#keys.get(key, prefix)
          let tags: string[] = []

          const pipeline = this.#primaryClient.pipeline()
          if (key.id) {
            const metadata = await this.#primaryClient.get(keys.metadata)

            pipeline.del(keys.metadata)
            pipeline.del(keys.body)

            if (metadata) {
              const { identifier } = JSON.parse(metadata) as CacheMetadata

              pipeline.zrem(keys.variants, identifier.hash)
              pipeline.zrem(keys.request, JSON.stringify(identifier))
              tags = identifier.tags
            }

            await pipeline.exec()

            this.emit('entry:delete', { id: key.id, prefix })
          } else {
            const pipeline = this.#primaryClient.pipeline()

            // Start iterating the sorted set for the requests
            await this.#iterateVariants<string>(keys.request, prefix, async (raw: string) => {
              const entry = JSON.parse(raw) as CacheIdentifier

              pipeline.zrem(keys.variants, entry.hash)
              pipeline.zrem(keys.request, raw)
              pipeline.del(replaceKeyPlaceholder(keys.metadata, entry.id))
              pipeline.del(replaceKeyPlaceholder(keys.body, entry.id))

              tags = entry.tags

              this.emit('entry:delete', { id: entry.id, prefix })
              return { expired: entry.expireAt < now }
            })

            await pipeline.exec()
          }

          if (tags.length > 0) {
            const pipeline = this.#primaryClient.pipeline()
            for (const tag of tags) {
              pipeline.zrem(`${keys.tags}|${tag}`, key.id ?? '')
            }
            await pipeline.exec()

            await this.deleteTags([tags], prefixes)
          }

          // Clean up of requests
          this.#enqueueCleanup(prefix, 'tags', tags)
          this.#enqueueCleanup(prefix, 'key', keys.request)
        },
        { concurrency: this.#concurrency }
      )
    }
  }

  async deleteIds (ids: string[], prefixes?: string | string[]): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    prefixes = this.#normalizePrefixes(prefixes)

    const toDelete: CacheKey[] = []

    await pMap(
      prefixes,
      async prefix => {
        const keys = this.#keys.get({}, prefix)
        const values = await this.#primaryClient.mget(ids.map(id => replaceKeyPlaceholder(keys.metadata, id)))

        for (const value of values) {
          const { id, origin, method, path } = JSON.parse(value!).entry as CacheEntry
          toDelete.push({ id, origin, method, path })
        }
      },
      { concurrency: this.#concurrency }
    )

    return this.deleteKeys(toDelete, prefixes)
  }

  // Despite the name, this deletes all entries matching ALL tags. This is for v1 compatibility
  async deleteTag (tags: string | string[], prefixes?: string | string[]): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    prefixes = this.#normalizePrefixes(prefixes)

    const toDelete = new Set<CacheKey>()
    tags = ensureArray(tags).sort()

    await pMap(
      prefixes,
      async prefix => {
        const keys = this.#keys.get({}, prefix)

        const tagKey = `${keys.tags}|${tags[0]}`

        // Do not use #iterateVariants since we need to get entries in batch as well
        // We only search for the first tag since we need entries matching ALL tags
        let offset = 0
        while (true) {
          const ids = await this.#primaryClient.zrange(
            tagKey,
            '+',
            '-',
            'BYLEX',
            'REV',
            'LIMIT',
            offset,
            this.#maxBatchSize
          )

          if (ids.length === 0) {
            break
          }

          offset += ids.length
          const membersData = await this.#primaryClient.mget(...ids.map(id => replaceKeyPlaceholder(keys.metadata, id)))

          for (const member of membersData) {
            if (!member) {
              continue
            }

            const {
              entry: { id, origin, method, path },
              identifier: { tags: entryTags }
            } = JSON.parse(member) as CacheMetadata

            let hasTags = true
            for (const tag of tags) {
              if (!entryTags.includes(tag)) {
                hasTags = false
              }
            }

            if (!hasTags) {
              continue
            }

            toDelete.add({ id, origin, method, path })
          }
        }
      },
      { concurrency: this.#concurrency }
    )

    if (toDelete.size) {
      await this.deleteKeys(toDelete, prefixes)
    }

    for (const prefix of prefixes) {
      /* c8 ignore next */
      for (const tag of ensureArray(tags)) {
        this.emit('tag:delete', { tag, prefix })
      }
    }
  }

  async deleteTags (tags: Array<string | string[]>, prefixes?: string | string[]): Promise<void> {
    const unique = new Set(tags)

    await pMap(unique, tag => this.deleteTag(tag, prefixes), { concurrency: this.#concurrency })
  }

  async streamEntries (
    callback: (entry: CacheEntry) => Promise<unknown> | unknown,
    prefixes?: string | string[]
  ): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    const now = Date.now() / 1000
    prefixes = this.#normalizePrefixes(prefixes)

    for (const prefix of prefixes) {
      const { routes } = this.#keys.get({}, prefix)

      await this.#iterateSet(routes, async routes => {
        return pMap(
          routes,
          async url => {
            const [origin, path] = url.split('|')
            const { requests } = this.#keys.get({ origin, path }, prefix)

            return this.#iterateSet(requests, async methods => {
              return pMap(
                methods,
                async method => {
                  const { request } = this.#keys.get({ origin, path, method }, prefix)

                  return this.#iterateSet(request, async identifiers => {
                    await pMap(
                      identifiers,
                      async identifier => {
                        const { id, expireAt } = JSON.parse(identifier) as CacheIdentifier
                        const keys = this.#keys.get({ origin, path, method }, prefix)

                        /* c8 ignore next 4 */
                        if (expireAt < now) {
                          this.#enqueueCleanup(prefix, 'key', keys.request)
                          return
                        }

                        const raw = await this.#primaryClient.get(replaceKeyPlaceholder(keys.metadata, id))

                        if (raw) {
                          const { identifier, entry: metadata } = JSON.parse(raw) as CacheMetadata
                          metadata.cacheTags = identifier.tags
                          await callback(metadata)
                        }
                      },
                      { concurrency: this.#concurrency }
                    )
                  })
                },
                { concurrency: this.#concurrency }
              )
            })
          },
          { concurrency: this.#concurrency }
        )
      })
    }
  }

  async subscribe (prefixes?: string | string[]): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      throw new UserError('Cache is closed.')
    }

    /* c8 ignore next 3 */
    if (this.#subscribed) {
      return
    }

    try {
      this.#subscriptionClient ??= new Redis({ ...this.#clientOptions, enableAutoPipelining: false })
      const events = getKeyspaceEventsChannels(this.#clientOptions, 'set', 'del', 'expired')

      if (this.#options.clientConfigKeyspaceEventNotify) {
        await this.#subscriptionClient.config('SET', 'notify-keyspace-events', 'AKE')
      }

      this.#subscriptionClient.on(
        'message',
        this.#onRedisSubscriptionMessage.bind(this, events, new Set(this.#normalizePrefixes(prefixes)))
      )

      await this.#subscriptionClient.subscribe(...Object.values(events))

      this.#subscribed = true
      /* c8 ignore next 7 */
    } catch (err) {
      await this.#closeClient(this.#subscriptionClient)
      this.#subscriptionClient = undefined
      this.#subscribed = false

      throw err
    }
  }

  async #trackingSubscribeInvalidations (prefixes?: string | string[]): Promise<void> {
    try {
      this.#subscriptionClient ??= new Redis({ ...this.#clientOptions, enableAutoPipelining: false })

      this.#subscriptionClient.on(
        'message',
        this.#onRedisTrackingSubscriptionMessage.bind(this, new Set(this.#normalizePrefixes(prefixes)))
      )

      const clientId = await this.#subscriptionClient.client('ID')
      await this.#primaryClient.client('TRACKING', 'ON', 'REDIRECT', clientId)
      await this.#subscriptionClient.subscribe('__redis__:invalidate')

      /* c8 ignore next 7 */
    } catch (err) {
      await this.#closeClient(this.#subscriptionClient)
      this.#subscribed = false
      this.#subscriptionClient = undefined

      throw err
    }
  }

  #getEntryTags (metadata: CacheEntry): string[] {
    if (!this.#cacheTagsHeader) {
      return []
    }

    /* c8 ignore next */
    for (const [key, value] of Object.entries(metadata.headers ?? {})) {
      if (key.toLowerCase() === this.#cacheTagsHeader) {
        /* c8 ignore next */
        return (Array.isArray(value) ? value : value.split(',')).sort()
      }
    }

    return []
  }

  // Two tags set are dependent if the children contains every tag of the parent
  #areTagsDependent (parent: string[], children: string[]): boolean {
    for (const tag of parent) {
      if (!children.includes(tag)) {
        return false
      }
    }

    return true
  }

  async #writeData (rawKey: CacheKey, metadata: CacheEntry, body: string): Promise<void> {
    /* c8 ignore next 3 */
    if (this.#closed) {
      return
    }

    if (!this.#xxhash) {
      this.#xxhash = await xxhash()
    }

    try {
      const { headers, id, ...keyParts } = rawKey
      const expireAt = Math.floor(metadata.deleteAt / 1000)
      const key = { ...keyParts, id: id ?? this.#generateId(), keyPrefix: this.#prefix }
      const keys = this.#keys.get(key, this.#prefix)
      const tags = this.#getEntryTags(metadata)
      const vary = serializeHeaders(metadata.vary)
      const hash = this.#xxhash.h64ToString(JSON.stringify(vary))
      const specificity = Object.keys(vary).length
      // Pad specificity to 4 digits to ensure correct lexicographical order
      const score = specificity.toString().padStart(4, '0')
      const identifier = { score, id: key.id, specificity, vary, hash, tags, expireAt }
      const entry = { ...key, ...metadata, cacheTags: tags }

      // If there is already an entry with the same vary, do not overwrite - This implements deduplication
      const result = await this.#primaryClient.zadd(keys.variants, 'NX', 0, hash)
      if (result === 0) {
        return
      }

      // Add other data
      const pipeline = this.#primaryClient.pipeline()

      pipeline.zadd(keys.routes, 0, `${key.origin}|${key.path}`)
      pipeline.zadd(keys.requests, 0, key.method)
      // IMPORTANT: score must be always be the first key in the identifier since we use ordering by lex order
      pipeline.zadd(keys.request, 0, JSON.stringify(identifier))
      pipeline.set(keys.metadata, JSON.stringify({ identifier, entry }), 'EXAT', expireAt)
      pipeline.set(keys.body, body, 'EXAT', expireAt)

      const tagsKeys: string[] = []

      for (const tag of tags) {
        pipeline.zadd(keys.tags, 0, tag)
        pipeline.zadd(`${keys.tags}|${tag}`, 0, key.id)
        tagsKeys.push(`${keys.tags}|${tag}`)
      }

      // For all the created keys, we need to issue two calls for expiration:
      // one will set it if the key does not exist, the other will update.
      for (const key of [keys.variants, keys.routes, keys.requests, keys.request, keys.tags, ...tagsKeys]) {
        pipeline.expireat(key, expireAt, 'NX')
        pipeline.expireat(key, expireAt, 'GT')
      }

      await pipeline.exec()

      this.emit('entry:write', { id: key.id, entry, prefix: this.#prefix })
      /* c8 ignore next 3 */
    } catch (err) {
      this.emit('error', err)
    }
  }

  async #iterateSet (key: string, cb: (ids: string[]) => unknown | Promise<unknown>): Promise<number> {
    let offset = 0
    let count = 0

    while (true) {
      const ids = await this.#primaryClient.zrange(key, '+', '-', 'BYLEX', 'REV', 'LIMIT', offset, this.#maxBatchSize)

      if (ids.length === 0) {
        break
      }

      await cb(ids)

      offset += ids.length
      count += ids.length
    }

    return count
  }

  async #iterateVariants<ReturnType> (
    key: string,
    prefix: string,
    cb: VariantsIterationResultCallback<ReturnType>
  ): Promise<ReturnType | undefined> {
    let offset = 0
    let returnValue: ReturnType | undefined
    let hasExpiredEntries = false
    const expiredEntries: Record<string, string[]> = {}

    while (!returnValue) {
      const res = await this.#primaryClient.zrange(key, '+', '-', 'BYLEX', 'REV', 'LIMIT', offset, this.#maxBatchSize)

      if (res.length === 0) {
        break
      }

      for (let i = 0; i < res.length; i++) {
        const { value, expired } = (await cb(res[i])) ?? {}

        // The member has expired, autoclean - Hard to test
        /* c8 ignore next 6 */
        if (expired) {
          hasExpiredEntries = true
          expiredEntries[key] ??= []
          expiredEntries[key].push(res[i])
          continue
        }

        if (typeof value !== 'undefined') {
          returnValue = value
          break
        }
      }

      offset += res.length
    }

    /* c8 ignore next 3 */
    if (hasExpiredEntries) {
      this.#enqueueCleanup(prefix, 'map', expiredEntries)
    }

    return returnValue
  }

  #enqueueCleanup (
    prefix: string,
    type: 'map' | 'tags' | 'key',
    target: Record<string, string[]> | string[] | string
  ): void {
    /* c8 ignore next 3 */
    if (this.#closed) {
      return
    }

    this.#cleanupQueue.push({ prefix, type, target })
    this.#scheduleCleanup()
  }

  #scheduleCleanup (): void {
    if (this.#cleaningScheduled) {
      return
    }

    this.#cleaningScheduled = true
    setImmediate(async () => {
      this.#cleanup()
    })
  }

  async #cleanup (): Promise<void> {
    this.#cleaningScheduled = false
    const task = this.#cleanupQueue.shift()

    if (!task) {
      setImmediate(() => this.emit('cleanup:complete'))

      return
    }

    this.#cleaningInProgress = true
    this.#secondaryClient ??= new Redis(this.#clientOptions)
    const pipeline = this.#secondaryClient.pipeline()

    try {
      switch (task.type) {
        case 'key':
          // Do not use pipeline here or the cleanup chain will fail
          /* c8 ignore next  */
          for (const key of ensureArray(task.target as string[])) {
            // Create the keys back from the request key
            const [origin, path, method] = key.split('|').slice(-3)
            const keys = this.#keys.get({ origin, path, method }, task.prefix)

            if ((await this.#secondaryClient.exists(keys.request)) === 0) {
              await this.#secondaryClient.zrem(keys.requests, method)
            }

            // Clean up of routes
            if ((await this.#secondaryClient.exists(keys.requests)) === 0) {
              await this.#secondaryClient.zrem(keys.routes, `${origin}|${path}`)
            }
          }

          break
        case 'tags':
          for (const tag of task.target as string[]) {
            const keys = this.#keys.get({}, task.prefix)
            const tagKey = `${keys.tags}|${tag}`

            if ((await this.#secondaryClient.zcard(tagKey)) < 1) {
              pipeline.zrem(keys.tags, tag)
            }
          }

          break
        /* c8 ignore next 8 */
        case 'map':
          for (const [setKey, members] of Object.entries(task.target as Record<string, string[]>)) {
            pipeline.zrem(setKey, ...members)
            this.#enqueueCleanup(task.prefix, 'key', setKey)
          }

          break
      }

      await pipeline.exec()
      this.emit('cleanup:task', task)

      // Continue with the next task
      this.#scheduleCleanup()
      /* c8 ignore next 8 */
    } catch (err) {
      // The connection was closed while cleaning up, ignore
      if (this.#closed && err.message === 'Connection is closed.') {
        return
      }

      this.emit('error', err)
    } finally {
      this.#cleaningInProgress = false
    }
  }

  async #onRedisSubscriptionMessage (
    channels: Record<string, string>,
    prefixes: Set<string>,
    channel: string,
    message: string
  ): Promise<void> {
    try {
      const noPrefix = prefixes.size === 1 && prefixes.has('')
      const components = message.split('|')

      /* c8 ignore next 5 */
      if (noPrefix) {
        components.unshift('')
      } else if (!prefixes.has(components[0])) {
        return
      }

      // Set
      if (channel === channels.set && components[1] === 'metadata') {
        const metadataRaw = await this.#primaryClient.get(message)

        /* c8 ignore next 3 */
        if (!metadataRaw) {
          return
        }

        const { entry, identifier } = JSON.parse(metadataRaw) as CacheMetadata
        entry.cacheTags = identifier.tags
        this.emit('subscription:entry:add', { id: entry.id, prefix: components[0], entry })
        // Delete or Expired
      } else if ((channel === channels.del || channel === channels.expired) && components[1] === 'metadata') {
        this.emit('subscription:entry:delete', { id: components[2], prefix: components[0] })
      }
      /* c8 ignore next 3 */
    } catch (err) {
      this.emit('error', err)
    }
  }

  async #onRedisTrackingSubscriptionMessage (prefixes: Set<string>, channel: string, key: string): Promise<void> {
    try {
      const noPrefix = prefixes.size === 1 && prefixes.has('')
      const components = key.split('|')

      /* c8 ignore next 5 */
      if (noPrefix) {
        components.unshift('')
      } else if (!prefixes.has(components[0])) {
        return
      }

      if (channel === '__redis__:invalidate' && components[1] === 'request') {
        const [prefix, , origin, path, method] = components
        this.tracking!.delete({ origin, path, method }, [prefix])
        this.emit('tracking:delete', { prefix, origin, path, method })
      }
      /* c8 ignore next 3 */
    } catch (err) {
      this.emit('error', err)
    }
  }

  #normalizePrefixes (prefixes: string | string[] | undefined): string[] {
    if (!prefixes) {
      return [this.#prefix]
    } else if (!Array.isArray(prefixes)) {
      return [prefixes]
    }

    return prefixes
  }

  async #closeClient (client: Redis | undefined): Promise<void> {
    if (!client) {
      return
    }

    if (['reconnecting', 'connecting', 'connect', 'ready'].includes(client.status)) {
      await client.disconnect()
    }
  }
}

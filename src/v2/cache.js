import { Redis } from 'iovalkey'
import { randomUUID } from 'node:crypto'
import { EventEmitter, setMaxListeners } from 'node:events'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import pMap from 'p-map'
import xxhash from 'xxhash-wasm'
import Keys from './keys.js'
import TrackingCache from './tracking-cache.js'
import {
  decodeBody,
  encodeBodyChunk,
  normalizePrefix,
  normalizePrefixes,
  serializeForHash,
  serializeHeaders,
  unique,
  validateHashTagPart,
  varyMatches
} from './utils.js'

const DATA_VERSION = 'v2'
const DEFAULT_MAX_ENTRY_SIZE = 10 * 1024 * 1024
const DEFAULT_MAX_BATCH_SIZE = 100
const DEFAULT_CONCURRENCY = 10
const { h64ToString } = await xxhash()

export default class RedisCache extends EventEmitter {
  #client
  #clientOpts
  #trackingClient
  #keyspaceClient
  #closed = false
  #subscribed = false
  #prefix
  #clusterId
  #maxEntrySize
  #maxBatchSize
  #concurrency
  #cacheTagsHeader
  #errorCallback
  #trackingCache
  #clientConfigKeyspaceEventNotify
  #abortController

  constructor (opts = {}) {
    super()

    if (typeof opts !== 'object') {
      throw new TypeError('expected opts to be an object')
    }

    const { keyPrefix, ...clientOpts } = opts.clientOpts ?? {}

    const prefix = validateHashTagPart('prefix', opts.prefix ?? keyPrefix ?? '', true)
    this.#prefix = normalizePrefix(prefix)
    this.#clusterId = opts.clusterId === undefined ? undefined : validateHashTagPart('clusterId', opts.clusterId, false)
    this.#clientOpts = { enableAutoPipelining: true, ...clientOpts }
    this.#client = new Redis(this.#clientOpts)
    this.#maxEntrySize = opts.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
    this.#maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    this.#concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.#cacheTagsHeader = opts.cacheTagsHeader?.toLowerCase()
    this.#clientConfigKeyspaceEventNotify = opts.clientConfigKeyspaceEventNotify ?? true
    this.#errorCallback = opts.errorCallback ?? ((err) => console.error('Unhandled error in RedisCache:', err))
    this.#abortController = new AbortController()
    setMaxListeners(100, this.#abortController.signal)

    if (opts.tracking !== false) {
      this.#trackingCache = new TrackingCache({ maxSize: opts.maxSize, maxCount: opts.maxCount })
      if (opts.clientConfigTracking !== false) {
        this.#subscribeTracking().catch(err => this.#errorCallback(err))
      }
    }
  }

  get version () {
    return '2.0.0'
  }

  get dataVersion () {
    return DATA_VERSION
  }

  get prefix () {
    return this.#prefix
  }

  get clusterId () {
    return this.#clusterId
  }

  get client () {
    return this.#client
  }

  async get (key, prefixes, includeBody = true) {
    if (this.#closed) {
      return undefined
    }

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const tracked = this.#trackingCache?.get(prefix, key)
      if (tracked) {
        if (includeBody === false) {
          const { body, ...metadata } = tracked
          return metadata
        }
        return tracked
      }

      const hashes = await this.#hashKey(key)
      const keys = new Keys(prefix, this.#clusterId)
      const resourceKey = keys.resource(hashes.resourceHash)
      const ids = await this.#getLiveIds(resourceKey)
      if (ids.length === 0) {
        continue
      }

      const entries = await this.#getEntriesByIds(prefix, ids)
      const headers = serializeHeaders(key.headers)
      let selected

      for (const entry of entries) {
        if (!varyMatches(entry, headers)) {
          continue
        }
        if (!selected || entry.specificity > selected.specificity) {
          selected = entry
        }
      }

      if (!selected) {
        continue
      }

      let body
      if (includeBody !== false) {
        const rawBody = await this.#client.get(keys.body(selected.id))
        if (rawBody === null) {
          await this.#deleteEntry(prefix, selected)
          continue
        }
        body = decodeBody(rawBody)
      }

      const value = this.#buildValue(selected, body)
      if (includeBody !== false) {
        this.#trackingCache?.set(prefix, selected, value)
      }
      return value
    }
  }

  async getKeys (keys, prefixes) {
    const results = []
    await this.#mapLimit(Array.from(keys), async key => {
      const result = await this.get(key, prefixes)
      if (result) {
        results.push(result)
      }
    })
    return results
  }

  createWriteStream (key, value) {
    let size = 0
    let body = ''
    let aborted = false
    const maxEntrySize = this.#maxEntrySize
    const errorCallback = this.#errorCallback
    const store = this

    return new Writable({
      write (chunk, encoding, callback) {
        const encoded = encodeBodyChunk(chunk, encoding)
        size += encoded.length

        if (size >= maxEntrySize) {
          aborted = true
          callback()
          return
        }

        body += body ? ` ${encoded}` : encoded
        callback()
      },
      final (callback) {
        if (aborted) {
          callback()
          return
        }

        store.#set(key, value, body)
          .then(() => callback())
          /* node:coverage ignore next 4 */
          /* c8 ignore next 4 */
          .catch(err => {
            errorCallback(err)
            callback(err)
          })
      }
    })
  }

  async delete (key, prefixes) {
    if (this.#closed) {
      return
    }

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const hashes = await this.#hashKey(key)
      const keys = new Keys(prefix, this.#clusterId)
      await this.#deleteByIndex(prefix, keys.originPath(hashes.originPathHash))
    }
  }

  async deleteKeys (inputKeys, prefixes) {
    if (this.#closed) {
      return
    }

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      await this.#mapLimit(Array.from(inputKeys), async key => {
        if (key.id) {
          await this.#deleteId(prefix, key.id)
          return
        }

        const hashes = await this.#hashKey(key)
        const keys = new Keys(prefix, this.#clusterId)
        await this.#deleteByIndex(prefix, keys.resourceIndex(hashes.resourceHash))
      })
    }
  }

  async deleteIds (ids, prefixes) {
    if (this.#closed) {
      return
    }

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      await this.#mapLimit(ids, id => this.#deleteId(prefix, id))
    }
  }

  async deleteTag (tags, prefixes) {
    if (!Array.isArray(tags)) {
      tags = [tags]
    }

    tags = unique(tags).filter(Boolean).sort()
    if (tags.length === 0) {
      return
    }

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const keys = new Keys(prefix, this.#clusterId)
      const tagHashes = await this.#getTagHashes(tags)
      const ids = await this.#getLiveIds(keys.tag(tagHashes[0]))
      const entries = await this.#getEntriesByIds(prefix, ids)
      const matching = entries.filter(entry => this.#shouldMatchAllTags(entry, tags))
      await this.#mapLimit(matching, entry => this.#deleteEntry(prefix, entry))

      for (const tag of tags) {
        this.emit('tag:delete', { tag, prefix })
      }
    }
  }

  async deleteTags (tags, prefixes) {
    await this.#mapLimit(tags, tag => this.deleteTag(tag, prefixes))
  }

  async entries (filter = {}, prefixes) {
    const results = []

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      if (filter.id) {
        const entry = await this.#getEntryById(prefix, filter.id)
        if (entry) {
          results.push(this.#buildEntryResult(entry))
        }
        continue
      }

      const indexKey = await this.#getIndexKey(prefix, filter)
      const ids = await this.#getLiveIds(indexKey)
      const entries = await this.#getEntriesByIds(prefix, ids)
      results.push(...entries.map(entry => this.#buildEntryResult(entry)))
    }

    return results
  }

  async deleteEntries (filter = {}, prefixes) {
    const deleted = []

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      if (filter.id) {
        const entry = await this.#getEntryById(prefix, filter.id)
        if (entry) {
          await this.#deleteEntry(prefix, entry)
          deleted.push(this.#buildEntryResult(entry))
        }
        continue
      }

      const indexKey = await this.#getIndexKey(prefix, filter)
      const ids = await this.#getLiveIds(indexKey)
      const entries = await this.#getEntriesByIds(prefix, ids)
      await this.#mapLimit(entries, async entry => {
        await this.#deleteEntry(prefix, entry)
        deleted.push(this.#buildEntryResult(entry))
      })
    }

    return deleted
  }

  async getTag (tag, prefixes) {
    const results = []
    const tagHash = await this.#hash(tag)

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const keys = new Keys(prefix, this.#clusterId)
      const ids = await this.#getLiveIds(keys.tag(tagHash))
      const entries = await this.#getEntriesByIds(prefix, ids)
      results.push(...entries.map(entry => this.#buildEntryResult(entry)))
    }

    return results
  }

  async getTags (tags, prefixes) {
    const results = []
    await this.#mapLimit(unique(tags.flat()), async tag => {
      results.push(...await this.getTag(tag, prefixes))
    })
    return results
  }

  async getDependentEntries (id, prefixes) {
    const results = new Map()

    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const source = await this.#getEntryById(prefix, id)
      if (!source || source.tags.length === 0) {
        continue
      }

      for (const tag of source.tags) {
        const entries = await this.getTag(tag, prefix)
        for (const entry of entries) {
          if (entry.id !== id && this.#shouldMatchAllTags(entry, source.tags)) {
            results.set(`${entry.prefix}:${entry.id}`, entry)
          }
        }
      }
    }

    return Array.from(results.values())
  }

  async getResponseById (id, prefixes) {
    for (const prefix of normalizePrefixes(this.#prefix, prefixes)) {
      const keys = new Keys(prefix, this.#clusterId)
      const entry = await this.#getEntryById(prefix, id)
      if (!entry) {
        continue
      }

      const rawBody = await this.#client.get(keys.body(id))
      if (rawBody === null) {
        continue
      }

      return decodeBody(rawBody).map(chunk => chunk.toString()).join('')
    }

    return null
  }

  async streamEntries (callback, prefixes) {
    for (const entry of await this.entries({}, prefixes)) {
      await callback(entry)
    }
  }

  async subscribe (prefixes) {
    if (this.#closed || this.#subscribed) {
      return
    }
    this.#subscribed = true

    const db = this.#clientOpts.db ?? 0
    const channels = {
      set: `__keyevent@${db}__:set`,
      del: `__keyevent@${db}__:del`,
      expired: `__keyevent@${db}__:expired`
    }
    const normalizedPrefixes = new Set(normalizePrefixes(this.#prefix, prefixes))

    try {
      this.#keyspaceClient = new Redis({ ...this.#clientOpts, enableAutoPipelining: false })

      if (this.#clientConfigKeyspaceEventNotify) {
        await this.#keyspaceClient.config('SET', 'notify-keyspace-events', 'AKE')
      }

      this.#keyspaceClient.on('message', async (channel, key) => {
        try {
          let matchedPrefix
          let entryPrefix

          for (const prefix of normalizedPrefixes) {
            const currentEntryPrefix = new Keys(prefix, this.#clusterId).entry('')
            if (key.startsWith(currentEntryPrefix)) {
              matchedPrefix = prefix
              entryPrefix = currentEntryPrefix
              break
            }
          }

          const prefix = matchedPrefix
          if (prefix === undefined) {
            return
          }

          const id = key.slice(entryPrefix.length)
          if (channel === channels.set) {
            const entry = await this.#getEntryById(prefix, id)
            if (!entry) {
              return
            }
            this.emit('subscription:entry:add', { prefix, id, metadata: entry, value: this.#buildValue(entry) })
          } else if (channel === channels.del || channel === channels.expired) {
            this.emit('subscription:entry:delete', { prefix, id })
          }
        } catch (err) {
          this.#errorCallback(err)
        }
      })

      await this.#keyspaceClient.subscribe(channels.set, channels.del, channels.expired)
      /* node:coverage ignore next 7 */
      /* c8 ignore next 6 */
    } catch (err) {
      this.#subscribed = false
      await this.#keyspaceClient?.quit()
      this.#keyspaceClient = undefined
      throw err
    }
  }

  async close () {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#abortController.abort()
    await sleep(100)

    const promises = [this.#client.quit()]
    if (this.#trackingClient) {
      promises.push(this.#trackingClient.quit())
    }

    if (this.#keyspaceClient) {
      promises.push(this.#keyspaceClient.quit())
    }
    await Promise.all(promises)
  }

  async #set (key, value, body) {
    if (this.#closed) {
      return
    }

    const cacheKey = { ...key, id: key.id ?? randomUUID() }
    const prefix = this.#prefix
    const keys = new Keys(prefix, this.#clusterId)
    const hashes = await this.#hashKey(cacheKey)
    const vary = serializeHeaders(value.vary)
    const varyHash = await this.#hash(serializeForHash(vary))
    let tags = []

    if (this.#cacheTagsHeader) {
      for (const [name, headerValue] of Object.entries(value.headers ?? {})) {
        if (name.toLowerCase() !== this.#cacheTagsHeader) {
          continue
        }

        tags = unique((Array.isArray(headerValue) ? headerValue.join(',') : headerValue).split(',').map(tag => tag.trim()).filter(Boolean)).sort()
        break
      }
    }

    const tagHashes = await this.#getTagHashes(tags)
    const deleteAt = Math.floor(value.deleteAt / 1000)
    const resourceKey = keys.resource(hashes.resourceHash)

    await this.#cleanupIndex(resourceKey)
    const existingEntries = await this.#getEntriesByIds(prefix, await this.#getLiveIds(resourceKey))
    const duplicate = existingEntries.find(entry => entry.varyHash === varyHash)
    if (duplicate) {
      await this.#deleteEntry(prefix, duplicate)
    }

    const entry = {
      id: cacheKey.id,
      prefix,
      origin: cacheKey.origin,
      method: cacheKey.method,
      path: cacheKey.path,
      originHash: hashes.originHash,
      originMethodHash: hashes.originMethodHash,
      originPathHash: hashes.originPathHash,
      resourceHash: hashes.resourceHash,
      varyHash,
      vary,
      specificity: Object.keys(vary).length,
      tags,
      tagHashes,
      statusCode: value.statusCode,
      statusMessage: value.statusMessage,
      headers: value.headers,
      cachedAt: value.cachedAt,
      staleAt: value.staleAt,
      deleteAt: value.deleteAt,
      cacheControlDirectives: value.cacheControlDirectives
    }

    if (value.headers?.etag) {
      entry.etag = value.headers.etag
    }

    const indexKeys = this.#getEntryIndexKeys(keys, entry)
    const pipeline = this.#client.pipeline()
    pipeline.set(keys.entry(entry.id), JSON.stringify(entry), 'EXAT', deleteAt)
    pipeline.set(keys.body(entry.id), body, 'EXAT', deleteAt)

    for (const indexKey of indexKeys) {
      pipeline.zadd(indexKey, deleteAt, entry.id)
      pipeline.expireat(indexKey, deleteAt, 'NX')
      pipeline.expireat(indexKey, deleteAt, 'GT')
    }

    await pipeline.exec()
    this.emit('entry:write', { prefix, id: entry.id, metadata: entry, value })
  }

  async #subscribeTracking () {
    this.#trackingClient ??= new Redis({ ...this.#clientOpts, enableAutoPipelining: false })
    const clientId = await this.#trackingClient.client('ID')
    await this.#client.client('TRACKING', 'ON', 'REDIRECT', clientId)
    await this.#trackingClient.subscribe('__redis__:invalidate')

    this.#trackingClient.on('message', (_channel, key) => {
      if (!key || !key.includes('data:v2:resource:')) {
        return
      }

      // Redis invalidations are key based. Deleting the whole resource bucket is safe.
      this.#trackingCache = new TrackingCache()
    })
  }

  #buildValue (entry, body) {
    const value = {
      statusCode: entry.statusCode,
      statusMessage: entry.statusMessage,
      headers: entry.headers,
      cachedAt: entry.cachedAt,
      staleAt: entry.staleAt,
      deleteAt: entry.deleteAt,
      cacheControlDirectives: entry.cacheControlDirectives,
      body
    }

    if (entry.etag) {
      value.etag = entry.etag
    }

    if (entry.vary && Object.keys(entry.vary).length > 0) {
      value.vary = entry.vary
    }

    return value
  }

  #buildEntryResult (entry) {
    return {
      id: entry.id,
      prefix: entry.prefix,
      origin: entry.origin,
      method: entry.method,
      path: entry.path,
      tags: entry.tags,
      cacheTags: entry.tags,
      statusCode: entry.statusCode,
      statusMessage: entry.statusMessage,
      headers: entry.headers,
      cachedAt: entry.cachedAt,
      staleAt: entry.staleAt,
      deleteAt: entry.deleteAt,
      cacheControlDirectives: entry.cacheControlDirectives
    }
  }

  #getEntryFromValue (value) {
    if (!value) {
      return
    }

    return JSON.parse(value)
  }

  #shouldMatchAllTags (entry, tags) {
    for (const tag of tags) {
      if (!entry.tags.includes(tag)) {
        return false
      }
    }

    return true
  }

  async #hashKey (key) {
    const originHash = await this.#hash(key.origin)
    const originMethodHash = await this.#hash(serializeForHash([key.origin, key.method]))
    const originPathHash = await this.#hash(serializeForHash([key.origin, key.path]))
    const resourceHash = await this.#hash(serializeForHash([key.origin, key.method, key.path]))

    return { originHash, originMethodHash, originPathHash, resourceHash }
  }

  async #hash (value) {
    return h64ToString(value)
  }

  async #getLiveIds (indexKey) {
    const now = Math.floor(Date.now() / 1000)
    await this.#cleanupIndex(indexKey, now)
    return this.#client.zrangebyscore(indexKey, `(${now}`, '+inf')
  }

  async #cleanupIndex (indexKey, now = Math.floor(Date.now() / 1000)) {
    await this.#client.zremrangebyscore(indexKey, '-inf', now)
  }

  async #getEntriesByIds (prefix, ids) {
    if (ids.length === 0) {
      return []
    }

    const keys = new Keys(prefix, this.#clusterId)
    const values = await this.#client.mget(...ids.map(id => keys.entry(id)))
    const entries = []
    const now = Date.now()

    for (const value of values) {
      const entry = this.#getEntryFromValue(value)
      if (!entry || entry.deleteAt <= now) {
        continue
      }

      entries.push(entry)
    }

    return entries
  }

  async #getEntryById (prefix, id) {
    const keys = new Keys(prefix, this.#clusterId)
    const entry = this.#getEntryFromValue(await this.#client.get(keys.entry(id)))
    if (!entry || entry.deleteAt <= Date.now()) {
      return
    }

    return entry
  }

  async #deleteByIndex (prefix, indexKey) {
    const ids = await this.#getLiveIds(indexKey)
    const entries = await this.#getEntriesByIds(prefix, ids)
    await this.#mapLimit(entries, entry => this.#deleteEntry(prefix, entry))
  }

  async #deleteId (prefix, id) {
    const entry = await this.#getEntryById(prefix, id)
    if (!entry) {
      return
    }

    await this.#deleteEntry(prefix, entry)
  }

  async #deleteEntry (prefix, entry) {
    const keys = new Keys(prefix, this.#clusterId)
    const pipeline = this.#client.pipeline()

    pipeline.del(keys.entry(entry.id))
    pipeline.del(keys.body(entry.id))
    for (const indexKey of this.#getEntryIndexKeys(keys, entry)) {
      pipeline.zrem(indexKey, entry.id)
    }

    await pipeline.exec()
    this.#trackingCache?.deleteEntry(prefix, entry)
    this.emit('entry:delete', { id: entry.id, prefix })
  }

  #getEntryIndexKeys (keys, entry) {
    const indexKeys = [
      keys.all(),
      keys.origin(entry.originHash),
      keys.originMethod(entry.originMethodHash),
      keys.originPath(entry.originPathHash),
      keys.resourceIndex(entry.resourceHash),
      keys.resource(entry.resourceHash)
    ]

    for (const tagHash of entry.tagHashes ?? []) {
      indexKeys.push(keys.tag(tagHash))
    }

    return indexKeys
  }

  async #getIndexKey (prefix, filter) {
    const keys = new Keys(prefix, this.#clusterId)
    if (!filter.origin) {
      return keys.all()
    }

    const hashes = await this.#hashKey({
      origin: filter.origin,
      method: filter.method ?? '',
      path: filter.path ?? ''
    })

    if (filter.method && filter.path) {
      return keys.resourceIndex(hashes.resourceHash)
    }

    if (filter.method) {
      return keys.originMethod(hashes.originMethodHash)
    }

    if (filter.path) {
      return keys.originPath(hashes.originPathHash)
    }

    return keys.origin(hashes.originHash)
  }

  async #getTagHashes (tags) {
    const hashes = new Array(tags.length)
    for (let i = 0; i < tags.length; i++) {
      hashes[i] = await this.#hash(tags[i])
    }
    return hashes
  }

  async #mapLimit (items, fn) {
    return pMap(items, item => {
      if (this.#abortController.signal.aborted) {
        return
      }

      return fn(item)
    }, { concurrency: this.#concurrency })
  }
}

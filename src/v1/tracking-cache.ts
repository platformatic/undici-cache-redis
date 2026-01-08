import lruMap from 'lru_map'
import type { CacheKey, CacheStoreOptions, CacheValue, CacheValueWithBody } from '../types.ts'
import type { ParsedRedisMetadataValue, RedisValue } from './redis-cache-store.ts'

export interface TrackingCacheValue<M, R> {
  metadata: M
  result: R
  size: number
}

export interface TrackingCacheValueWithKey<M, R, K> extends TrackingCacheValue<M, R> {
  key: K
}

export type CachedMetadata = RedisValue | ParsedRedisMetadataValue | CacheValue

export class TrackingCache<
  Key extends CacheKey = CacheKey,
  Metadata extends Partial<CachedMetadata> = CachedMetadata,
  Result extends Partial<CacheValueWithBody> = CacheValueWithBody
> {
  #data: lruMap.LRUMap<string, Map<string, TrackingCacheValue<Metadata, Result>>>
  #maxCount
  #maxSize
  #count = 0
  #size = 0

  constructor (opts: Pick<CacheStoreOptions, 'maxCount' | 'maxSize'> = {}) {
    this.#maxCount = opts.maxCount ?? Infinity
    this.#maxSize = opts.maxSize ?? Infinity
    this.#data = new lruMap.LRUMap(this.#maxCount + 1)
  }

  get count (): number {
    return this.#count
  }

  get size (): number {
    return this.#size
  }

  get (key: Key): Result | undefined {
    const entry = this.#findMatchingEntry(key)
    return entry?.result
  }

  set (key: Key, metadata: Metadata, result: Result): void {
    const entry = this.#findMatchingEntry(key)
    if (entry !== undefined) {
      this.delete(entry.key)
    }

    const trackingMetadataKey = serializeTackingMetadataKey(key)

    let entries = this.#data.get(trackingMetadataKey)
    if (entries === undefined) {
      entries = new Map()
      this.#data.set(trackingMetadataKey, entries)
    }
    const size = this.#countResultSize(result)
    entries.set(key.id!, { metadata, result, size })

    this.#count++
    this.#size += size

    if (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      this.#clean()
    }
  }

  delete (key: Key): void {
    const trackingMetadataKey = serializeTackingMetadataKey(key)
    const entries = this.#data.get(trackingMetadataKey)
    if (entries === undefined) return

    const entry = entries.get(key.id!)
    /* c8 ignore next */
    if (entry === undefined) return

    entries.delete(key.id!)

    this.#count--
    this.#size -= entry.size

    if (entries.size === 0) {
      this.#data.delete(trackingMetadataKey)
    }
  }

  #findMatchingEntry (key: Key): TrackingCacheValueWithKey<Metadata, Result, Key> | undefined {
    const trackingMetadataKey = serializeTackingMetadataKey(key)
    const entries = this.#data.get(trackingMetadataKey)
    if (entries === undefined) return undefined

    for (const [id, entry] of entries.entries()) {
      let matches = true
      const vary = (entry.metadata as CacheValue).vary as Record<string, string | null> | undefined

      if (vary) {
        const headers = key.headers || {}

        for (const header in vary) {
          /* c8 ignore next 3 */
          if (headers[header] === undefined && vary[header] === null) {
            continue
          }

          if (headers[header] !== vary[header]) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        return { ...entry, key: { ...key, id } }
      }
    }
  }

  #countResultSize (result: Result): number {
    let size = 0
    for (const buffer of result.body as Iterable<Buffer>) {
      size += buffer.length
    }
    return size
  }

  #clean () {
    while (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      const entries = this.#data.shift()![1]
      for (const entry of entries.values()) {
        this.#count--
        this.#size -= entry.size
      }
    }
  }
}

function serializeTackingMetadataKey<Key extends CacheKey> (key: Key): string {
  const { origin, path, method } = key

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${encodedOrigin}:${encodedPath}:${method}`
}

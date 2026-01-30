import lruMap from 'lru_map'
import type { CacheKey, CacheStoreOptions, CacheValueWithBody } from '../types.ts'
import type { CacheEntry, Keys } from './types.ts'
import { serializeHeaders, varyMatches } from './utils.ts'

export class TrackingCache {
  #data: lruMap.LRUMap<string, CacheEntry[]>
  #count: number
  #size: number
  #maxSize: number
  #maxCount: number

  constructor (options: Pick<CacheStoreOptions, 'maxSize' | 'maxCount'>) {
    this.#count = 0
    this.#size = 0
    this.#maxCount = options.maxCount ?? Number.POSITIVE_INFINITY
    this.#maxSize = options.maxSize ?? Number.POSITIVE_INFINITY
    this.#data = new lruMap.LRUMap(this.#maxCount + 1)
  }

  get count (): number {
    return this.#count
  }

  get size (): number {
    return this.#size
  }

  get (key: CacheKey, prefixes: string[]): CacheValueWithBody | undefined {
    const headers = serializeHeaders(key.headers)

    for (const prefix of prefixes) {
      const entries = this.#data.get(this.#getRequestKey(key, prefix))

      if (entries === undefined) {
        continue
      }

      for (const entry of entries) {
        if (varyMatches(entry.metadata, headers)) {
          return entry.value as CacheValueWithBody
        }
      }
    }

    return undefined
  }

  set (keys: Keys, metadata: CacheEntry): void {
    const key = keys.request

    let entries = this.#data.get(key)
    if (entries === undefined) {
      entries = []
      this.#data.set(key, entries)
    }

    // Search if there is already an entry with the same prefix
    const hash = metadata.metadata!.hash
    const existingEntry = entries.some(entry => entry.metadata.hash === hash)

    /* c8 ignore next 3 */
    if (existingEntry) {
      return
    }

    entries.push(metadata)
    // Always keep the most specific entries first
    entries.sort((a, b) => b.metadata.specificity - a.metadata.specificity)

    // Update counters
    this.#count++
    this.#size += this.#calculateEntrySize(metadata.value as CacheValueWithBody)

    // If we exceed size limits, clean up
    if (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      this.#cleanup()
    }
  }

  delete (key: CacheKey, prefixes: string[]): void {
    for (const prefix of prefixes) {
      const entries = this.#data.delete(this.#getRequestKey(key, prefix))

      if (entries) {
        this.#afterRemove(entries)
      }
    }
  }

  #calculateEntrySize (result: CacheValueWithBody): number {
    let size = 0

    for (const buffer of result.body as Iterable<Buffer>) {
      size += buffer.length
    }

    return size
  }

  #cleanup () {
    // If there is a single large entry, we keep even if it exceeds maxSize. Upon the next addition, it will be removed
    while ((this.#count > this.#maxCount || this.#size > this.#maxSize) && this.#data.size > 1) {
      const entries = this.#data.shift()![1]
      this.#afterRemove(entries)
    }
  }

  #afterRemove (entries: CacheEntry[]): void {
    for (const entry of entries) {
      this.#count--
      this.#size -= this.#calculateEntrySize(entry.value as CacheValueWithBody)
    }
  }

  // Keep this in sync with KeysStorage#get
  #getRequestKey (key: CacheKey, prefix?: string): string {
    /* c8 ignore next */
    return `${prefix ?? ''}${prefix?.length ? '|' : ''}request|${key.origin ?? ''}|${key.path ?? ''}|${key.method ?? ''}`
  }
}

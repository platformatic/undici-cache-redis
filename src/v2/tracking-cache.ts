import lruMap from 'lru_map'
import type { CacheEntryWithBody, CacheKey, CacheStoreOptions } from '../types.ts'
import type { CacheMetadata, Keys } from './types.ts'
import { KeysStorage, serializeHeaders, varyMatches } from './utils.ts'

export class TrackingCache {
  #data: lruMap.LRUMap<string, CacheMetadata[]>
  #keys: KeysStorage
  #count: number
  #size: number
  #maxSize: number
  #maxCount: number

  constructor (options: Pick<CacheStoreOptions, 'maxSize' | 'maxCount'>) {
    this.#keys = new KeysStorage()
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

  get (key: CacheKey, prefixes: string[]): CacheEntryWithBody | undefined {
    const headers = serializeHeaders(key.headers)

    for (const prefix of prefixes) {
      const keys = this.#keys.get(key, prefix)

      const entries = this.#data.get(keys.request)

      if (entries === undefined) {
        continue
      }

      for (const entry of entries) {
        if (varyMatches(entry.identifier, headers)) {
          return entry.entry as CacheEntryWithBody
        }
      }
    }

    return undefined
  }

  set (keys: Keys, metadata: CacheMetadata): void {
    const key = keys.request

    let entries = this.#data.get(key)
    if (entries === undefined) {
      entries = []
      this.#data.set(key, entries)
    }

    // Search if there is already an entry with the same prefix
    const hash = metadata.identifier!.hash
    const existingEntry = entries.some(entry => entry.identifier.hash === hash)

    /* c8 ignore next 3 */
    if (existingEntry) {
      return
    }

    entries.push(metadata)
    // Always keep the most specific entries first
    entries.sort((a, b) => b.identifier.specificity - a.identifier.specificity)

    // Update counters
    this.#count++
    this.#size += this.#calculateEntrySize(metadata.entry as CacheEntryWithBody)

    // If we exceed size limits, clean up
    if (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      this.#cleanup()
    }
  }

  delete (key: CacheKey, prefixes: string[]): void {
    for (const prefix of prefixes) {
      const keys = this.#keys.get(key, prefix)
      const entries = this.#data.delete(keys.request)

      if (entries) {
        this.#afterRemove(entries)
      }
    }
  }

  #calculateEntrySize (result: CacheEntryWithBody): number {
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

  #afterRemove (entries: CacheMetadata[]): void {
    for (const entry of entries) {
      this.#count--
      this.#size -= this.#calculateEntrySize(entry.entry as CacheEntryWithBody)
    }
  }
}

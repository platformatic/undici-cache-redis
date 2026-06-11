import lruMap from 'lru_map'
import { serializeHeaders, varyMatches } from './utils.js'

const { LRUMap } = lruMap

export default class TrackingCache {
  #data
  #maxCount
  #maxSize
  #count = 0
  #size = 0

  constructor (opts = {}) {
    this.#maxCount = opts.maxCount ?? Infinity
    this.#maxSize = opts.maxSize ?? Infinity
    this.#data = new LRUMap(this.#maxCount + 1)
  }

  get count () {
    return this.#count
  }

  get size () {
    return this.#size
  }

  get (prefix, key) {
    const entries = this.#data.get(serializeKey(prefix, key))
    if (!entries) {
      return
    }

    const headers = serializeHeaders(key.headers)
    let best

    for (const entry of entries.values()) {
      if (!varyMatches(entry.metadata, headers)) {
        continue
      }

      if (!best || entry.metadata.specificity > best.metadata.specificity) {
        best = entry
      }
    }

    return best?.value
  }

  set (prefix, metadata, value) {
    const key = serializeKey(prefix, metadata)
    let entries = this.#data.get(key)
    if (!entries) {
      entries = new Map()
      this.#data.set(key, entries)
    }

    const existing = entries.get(metadata.id)
    if (existing) {
      this.#count--
      this.#size -= existing.size
    }

    let size = 0
    for (const chunk of value.body ?? []) {
      size += chunk.length
    }

    entries.set(metadata.id, { metadata, value, size })
    this.#count++
    this.#size += size

    while (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      const shifted = this.#data.shift()
      if (!shifted) {
        return
      }
      for (const entry of shifted[1].values()) {
        this.#count--
        this.#size -= entry.size
      }
    }
  }

  delete (prefix, key) {
    const entries = this.#data.get(serializeKey(prefix, key))
    if (!entries) {
      return
    }

    for (const entry of entries.values()) {
      this.#count--
      this.#size -= entry.size
    }
    this.#data.delete(serializeKey(prefix, key))
  }

  deleteEntry (prefix, metadata) {
    const key = serializeKey(prefix, metadata)
    const entries = this.#data.get(key)
    if (!entries) {
      return
    }

    const existing = entries.get(metadata.id)
    if (!existing) {
      return
    }

    entries.delete(metadata.id)
    this.#count--
    this.#size -= existing.size

    if (entries.size === 0) {
      this.#data.delete(key)
    }
  }
}

function serializeKey (prefix, key) {
  return `${prefix}${key.origin}\0${key.method}\0${key.path}`
}

'use strict'

const { LRUMap } = require('lru_map')

class TrackingCache {
  /**
   * @type {LRUMap}
   */
  #data

  /**
   * @type {number}
   */
  #maxCount

  /**
   * @type {number}
   */
  #maxSize

  /**
   * @type {number}
   */
  #count = 0

  /**
   * @type {number}
   */
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

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {import('./internal-types.d.ts').GetResult | undefined}
   */
  get (key) {
    const entry = this.#findMatchingEntry(key)
    return entry?.result
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {object} metadata
   * @param {import('./internal-types.d.ts').GetResult} result
   * @returns {void}
   */
  set (key, metadata, result) {
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
    entries.set(key.id, { metadata, result, size })

    this.#count++
    this.#size += size

    if (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      this.#clean()
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {void}
   */
  delete (key) {
    const trackingMetadataKey = serializeTackingMetadataKey(key)
    const entries = this.#data.get(trackingMetadataKey)
    if (entries === undefined) return

    const entry = entries.get(key.id)
    if (entry === undefined) return

    entries.delete(key.id)

    this.#count--
    this.#size -= entry.size

    if (entries.size === 0) {
      this.#data.delete(trackingMetadataKey)
    }
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @returns {{ metadata: object, result: object } | undefined}
   */
  #findMatchingEntry (key) {
    const trackingMetadataKey = serializeTackingMetadataKey(key)
    const entries = this.#data.get(trackingMetadataKey)
    if (entries === undefined) return undefined

    for (const [id, entry] of entries.entries()) {
      let matches = true

      const vary = entry.metadata.vary
      if (vary) {
        if (!key.headers) continue

        for (const header in vary) {
          if (key.headers[header] !== vary[header]) {
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

  #countResultSize (result) {
    let size = 0
    for (const buffer of result.body) {
      size += buffer.length
    }
    return size
  }

  #clean () {
    while (this.#count > this.#maxCount || this.#size > this.#maxSize) {
      const entries = this.#data.shift()[1]
      for (const entry of entries.values()) {
        this.#count--
        this.#size -= entry.size
      }
    }
  }
}

function serializeTackingMetadataKey (key) {
  const { origin, path, method } = key

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${encodedOrigin}:${encodedPath}:${method}`
}

module.exports = TrackingCache

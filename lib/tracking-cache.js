'use strict'

const { LRUMap } = require('lru_map')
const { normalizeHeaders, varyMatches } = require('./vary.js')

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
    const groupKey = serializeGroupKey(key)
    const entries = this.#data.get(groupKey)
    if (entries === undefined) return undefined

    const now = Date.now()
    let headers
    let bestMatch
    let bestMatchVaryCount = -1

    for (const [id, entry] of entries) {
      if (entry.result.deleteAt <= now) {
        this.#removeEntry(entries, id)
        continue
      }

      if (entry.method !== key.method) continue

      const vary = entry.metadata.vary
      const varyCount = vary ? Object.keys(vary).length : 0
      if (varyCount <= bestMatchVaryCount) continue

      if (vary) headers ??= normalizeHeaders(key.headers)
      if (varyMatches(vary, headers)) {
        bestMatch = entry
        bestMatchVaryCount = varyCount
      }
    }

    if (entries.size === 0) this.#data.delete(groupKey)

    return bestMatch?.result
  }

  /**
   * @param {import('./internal-types.d.ts').CacheKey} key
   * @param {{ vary?: Record<string, string | string[] | null> }} metadata
   * @param {import('./internal-types.d.ts').GetResult} result
   * @returns {void}
   */
  set (key, metadata, result) {
    const groupKey = serializeGroupKey(key)
    let entries = this.#data.get(groupKey)
    if (entries === undefined) {
      entries = new Map()
      this.#data.set(groupKey, entries)
    }

    // A new entry replaces any entry with the same id or for the same variant
    const varySignature = JSON.stringify(metadata.vary ?? null)
    for (const [id, entry] of entries) {
      if (id === key.id || (entry.method === key.method && entry.varySignature === varySignature)) {
        this.#removeEntry(entries, id)
      }
    }

    const size = countResultSize(result)
    entries.set(key.id, { method: key.method, metadata, varySignature, result, size })

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
    const groupKey = serializeGroupKey(key)
    const entries = this.#data.get(groupKey)
    if (entries === undefined || !entries.has(key.id)) return

    this.#removeEntry(entries, key.id)
    if (entries.size === 0) this.#data.delete(groupKey)
  }

  clear () {
    this.#data.clear()
    this.#count = 0
    this.#size = 0
  }

  #removeEntry (entries, id) {
    this.#count--
    this.#size -= entries.get(id).size
    entries.delete(id)
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

function countResultSize (result) {
  let size = 0
  for (const buffer of result.body) {
    size += buffer.length
  }
  return size
}

function serializeGroupKey (key) {
  const { origin, path, method } = key

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${encodedOrigin}:${encodedPath}:${method}`
}

module.exports = TrackingCache

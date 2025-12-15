import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import type { CacheEntry, CacheEntryWithBody, CacheKey } from '../../src/types.ts'
import { TrackingCache, type TrackingCacheEntryWithKey } from '../../src/v1/tracking-cache.ts'

test('should override cache entries', async () => {
  const cache = new TrackingCache<CacheKey, Partial<CacheEntry>, Partial<CacheEntryWithBody>>()

  // Fill the cache with a same entries
  for (let i = 0; i < 10; i++) {
    const entry = generateCacheEntry({ id: i, origin: 'http://test.com' })
    cache.set(entry.key, entry.metadata, entry.result)
  }

  strictEqual(cache.count, 1)
})

test('should delete values when reaching a count threshold', async () => {
  const maxCount = 5

  const cache = new TrackingCache<CacheKey, Partial<CacheEntry>, Partial<CacheEntryWithBody>>({ maxCount })
  const entries = []

  // Fill the cache
  for (let i = 0; i < maxCount; i++) {
    const entry = generateCacheEntry({ id: i, origin: `http://test-${i}.com` })
    cache.set(entry.key, entry.metadata, entry.result)
    entries.push(entry)
  }

  // Trigger first two entries for the lru
  cache.get(entries[0].key)
  cache.get(entries[1].key)

  // Add an extra entry that should trigger the deletion
  const entry = generateCacheEntry({ id: maxCount, origin: 'http://extra.com' })
  cache.set(entry.key, entry.metadata, entry.result)
  entries.push(entry)

  strictEqual(cache.count, maxCount)

  deepStrictEqual(cache.get(entries[0].key), entries[0].result)
  deepStrictEqual(cache.get(entries[1].key), entries[1].result)
  deepStrictEqual(cache.get(entries[2].key), undefined)
  deepStrictEqual(cache.get(entries[3].key), entries[3].result)
  deepStrictEqual(cache.get(entries[4].key), entries[4].result)
})

test('should delete values when reaching a size threshold', async () => {
  const maxSize = 100
  const bodySize = 10
  const cacheSize = maxSize / bodySize

  const cache = new TrackingCache<CacheKey, Partial<CacheEntry>, Partial<CacheEntryWithBody>>({ maxSize })
  const entries = []

  // Fill the cache
  for (let i = 0; i < cacheSize; i++) {
    const entry = generateCacheEntry({
      id: i,
      origin: `http://test-${i}.com`,
      body: i.toString().repeat(bodySize)
    })
    cache.set(entry.key, entry.metadata, entry.result)
    entries.push(entry)
  }

  // Trigger first two entries for the lru
  cache.get(entries[0].key)
  cache.get(entries[1].key)

  // Add an extra entry that should trigger the deletion
  const entry = generateCacheEntry({
    id: cacheSize,
    origin: 'http://extra.com',
    body: 'e'.repeat(bodySize)
  })

  cache.set(entry.key, entry.metadata, entry.result)
  entries.push(entry)

  strictEqual(cache.size, maxSize)

  deepStrictEqual(cache.get(entries[0].key), entries[0].result)
  deepStrictEqual(cache.get(entries[1].key), entries[1].result)
  deepStrictEqual(cache.get(entries[2].key), undefined)
  deepStrictEqual(cache.get(entries[3].key), entries[3].result)
  deepStrictEqual(cache.get(entries[4].key), entries[4].result)
})

test('should respect unused vary directives', async t => {
  const cache = new TrackingCache<CacheKey, Partial<CacheEntry>, Partial<CacheEntryWithBody>>()

  const entry1 = generateCacheEntry({
    id: 'entry1',
    origin: 'http://test.com'
  })
  cache.set(entry1.key, { vary: { 'Accept-Encoding': null } }, entry1.result)

  strictEqual(cache.count, 1)

  await t.test('should match with not relevant headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { Cookie: 'foo=bar;' } }), entry1.result)
  })

  await t.test('should match with undefined headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: undefined }), entry1.result)
  })

  await t.test('should not match with a non-empty header', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { 'Accept-Encoding': 'gzip' } }), undefined)
  })
})

test('should respect vary directives', async t => {
  const cache = new TrackingCache<CacheKey, Partial<CacheEntry>, Partial<CacheEntryWithBody>>()

  const entry1 = generateCacheEntry({
    id: 'entry1',
    origin: 'http://test.com'
  })
  cache.set(entry1.key, { vary: { 'Accept-Encoding': 'gzip' } }, entry1.result)

  strictEqual(cache.count, 1)

  await t.test('should not match with not relevant headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { Cookie: 'foo=bar;' } }), undefined)
  })

  await t.test('should not match with undefined headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: undefined }), undefined)
  })

  await t.test('should not match with a wrong header value', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { 'Accept-Encoding': 'deflate' } }), undefined)
  })

  await t.test('should match with the same header value', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { 'Accept-Encoding': 'gzip' } }), entry1.result)
  })
})

function generateCacheEntry ({
  id,
  origin,
  body
}: {
  id: string | number
  origin: string
  body?: string
}): TrackingCacheEntryWithKey<Partial<CacheEntry>, Partial<CacheEntryWithBody>, CacheKey> {
  id = (id ?? Math.random().toString(36).slice(2)).toString()
  origin = origin ?? 'http://test.com'
  body = body ?? 'test-body'

  return {
    key: { id, origin, path: '/foo', method: 'GET' },
    result: { body: [body] },
    metadata: {},
    size: 0
  }
}

'use strict'

const { test } = require('node:test')
const { strictEqual, deepStrictEqual, notStrictEqual } = require('node:assert')
const TrackingCache = require('../lib/tracking-cache')

test('should override cache entries', async () => {
  const cache = new TrackingCache()

  // Fill the cache with a same entries
  for (let i = 0; i < 10; i++) {
    const entry = generateCacheEntry({ id: i, origin: 'http://test.com' })
    cache.set(entry.key, entry.metadata, entry.value)
  }

  strictEqual(cache.count, 1)
})

test('should delete values when reaching a count threshold', async () => {
  const maxCount = 5

  const cache = new TrackingCache({ maxCount })
  const entries = []

  // Fill the cache
  for (let i = 0; i < maxCount; i++) {
    const entry = generateCacheEntry({ id: i, origin: `http://test-${i}.com` })
    cache.set(entry.key, entry.metadata, entry.value)
    entries.push(entry)
  }

  // Trigger first two entries for the lru
  cache.get(entries[0].key)
  cache.get(entries[1].key)

  // Add an extra entry that should trigger the deletion
  const entry = generateCacheEntry({ id: maxCount, origin: 'http://extra.com' })
  cache.set(entry.key, entry.metadata, entry.value)
  entries.push(entry)

  strictEqual(cache.count, maxCount)

  deepStrictEqual(cache.get(entries[0].key), entries[0].value)
  deepStrictEqual(cache.get(entries[1].key), entries[1].value)
  deepStrictEqual(cache.get(entries[2].key), undefined)
  deepStrictEqual(cache.get(entries[3].key), entries[3].value)
  deepStrictEqual(cache.get(entries[4].key), entries[4].value)
})

test('should delete values when reaching a size threshold', async () => {
  const maxSize = 100
  const bodySize = 10
  const cacheSize = maxSize / bodySize

  const cache = new TrackingCache({ maxSize })
  const entries = []

  // Fill the cache
  for (let i = 0; i < cacheSize; i++) {
    const entry = generateCacheEntry({
      id: i,
      origin: `http://test-${i}.com`,
      body: i.toString().repeat(bodySize),
    })
    cache.set(entry.key, entry.metadata, entry.value)
    entries.push(entry)
  }

  // Trigger first two entries for the lru
  cache.get(entries[0].key)
  cache.get(entries[1].key)

  // Add an extra entry that should trigger the deletion
  const entry = generateCacheEntry({
    id: cacheSize,
    origin: 'http://extra.com',
    body: 'e'.repeat(bodySize),
  })

  cache.set(entry.key, entry.metadata, entry.value)
  entries.push(entry)

  strictEqual(cache.size, maxSize)

  deepStrictEqual(cache.get(entries[0].key), entries[0].value)
  deepStrictEqual(cache.get(entries[1].key), entries[1].value)
  deepStrictEqual(cache.get(entries[2].key), undefined)
  deepStrictEqual(cache.get(entries[3].key), entries[3].value)
  deepStrictEqual(cache.get(entries[4].key), entries[4].value)
})

test('should respect unused vary directives', async (t) => {
  const cache = new TrackingCache()

  const entry1 = generateCacheEntry({
    id: 'entry1',
    origin: 'http://test.com',
  })
  cache.set(entry1.key, { vary: { 'Accept-Encoding': undefined } }, entry1.value)

  strictEqual(cache.count, 1)

  await t.test('should match with not relevant headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { Cookie: 'foo=bar;' } }), entry1.value)
  })

  await t.test('should match with undefined headers', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: undefined }), entry1.value)
  })

  await t.test('should not match with a non-empty header', () => {
    deepStrictEqual(cache.get({ ...entry1.key, headers: { 'Accept-Encoding': 'gzip' } }), undefined)
  })
})

test('should respect vary directives', async (t) => {
  const cache = new TrackingCache()

  const entry1 = generateCacheEntry({
    id: 'entry1',
    origin: 'http://test.com',
  })
  cache.set(entry1.key, { vary: { 'Accept-Encoding': 'gzip' } }, entry1.value)

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
    deepStrictEqual(cache.get({ ...entry1.key, headers: { 'Accept-Encoding': 'gzip' } }), entry1.value)
  })
})

test('should return the most specific matching vary entry', async () => {
  const cache = new TrackingCache()

  const entry1 = generateCacheEntry({
    id: 'entry1',
    origin: 'http://test.com',
    body: 'specific'
  })
  cache.set(entry1.key, {
    vary: {
      'test-header-1': 'foo',
      'test-header-2': 'foo',
      'test-header-3': 'foo'
    }
  }, entry1.value)

  const entry2 = generateCacheEntry({
    id: 'entry2',
    origin: 'http://test.com',
    body: 'generic'
  })
  cache.set(entry2.key, {
    vary: {
      'test-header-1': 'foo',
      'test-header-2': 'foo'
    }
  }, entry2.value)

  deepStrictEqual(cache.get({
    ...entry1.key,
    headers: {
      'Test-Header-1': 'foo',
      'Test-Header-2': 'foo',
      'Test-Header-3': 'foo'
    }
  }), entry1.value)
})

test('should not return expired entries', async () => {
  const cache = new TrackingCache()

  const entry = generateCacheEntry({ id: 'entry1' })
  cache.set(entry.key, entry.metadata, { ...entry.value, deleteAt: Date.now() - 1 })

  strictEqual(cache.get(entry.key), undefined)
  strictEqual(cache.count, 0)
  strictEqual(cache.size, 0)
})

test('should only change the version of invalidated groups', async () => {
  const cache = new TrackingCache()
  const version = cache.version('group')

  cache.deleteGroup('other')
  strictEqual(cache.version('group'), version)

  cache.deleteGroup('group')
  const invalidated = cache.version('group')
  notStrictEqual(invalidated, version)

  cache.clear()
  notStrictEqual(cache.version('group'), invalidated)
})

test('should remember misses until the group changes', async () => {
  const cache = new TrackingCache()
  const entry = generateCacheEntry({ id: 'entry1' })

  strictEqual(cache.hasMiss('group'), false)
  cache.setMiss('group')
  strictEqual(cache.hasMiss('group'), true)

  cache.deleteGroup('group')
  strictEqual(cache.hasMiss('group'), false)

  cache.setMiss('group')
  cache.set(entry.key, entry.metadata, entry.value, 'group')
  strictEqual(cache.hasMiss('group'), false)

  cache.setMiss('group')
  cache.clear()
  strictEqual(cache.hasMiss('group'), false)
})

function generateCacheEntry ({ id, origin, body, metadata }) {
  id = id ?? Math.random().toString(36).slice(2)
  origin = origin ?? 'http://test.com'
  body = body ?? 'test-body'

  return {
    key: { id, origin, path: '/foo', method: 'GET' },
    value: { body: [body], deleteAt: Infinity },
    metadata: {},
  }
}

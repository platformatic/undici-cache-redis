'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const RedisCacheStore = require('../index.js')
const { cleanValkey } = require('./helper.js')

test('should notify when a new key is added', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const keyPrefix = 'foo:bar:'
  const store = new RedisCacheStore({ clientOpts: { keyPrefix } })
  await store.subscribe()

  const entries = []
  store.on('add-entry', (entry) => {
    entries.push(entry)
  })

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  assert.strictEqual(requestsToOrigin, 0)

  {
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for redis to save the response
  await sleep(1000)

  {
    // Send second request that should be handled by cache
    const { statusCode, body, headers } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')

    assert.strictEqual(headers.age, '1')
  }

  assert.strictEqual(entries.length, 1)

  const newEntry = entries[0]
  assert.ok(newEntry.id)
  assert.strictEqual(newEntry.keyPrefix, keyPrefix)
  assert.strictEqual(newEntry.origin, origin)
  assert.strictEqual(newEntry.path, '/')
  assert.strictEqual(newEntry.method, 'GET')
  assert.strictEqual(newEntry.statusCode, 200)
  assert.ok(newEntry.headers)
  assert.strictEqual(typeof newEntry.cachedAt, 'number')
  assert.strictEqual(typeof newEntry.deleteAt, 'number')
})

test('should notify when invalidates response by cache tag', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const cacheTag = 'test-cache-tag-value-42'
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const keyPrefix = 'foo:bar:'
  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag',
    clientOpts: { keyPrefix }
  })
  await store.subscribe()

  const addedEntries = []
  store.on('add-entry', (entry) => {
    addedEntries.push(entry)
  })

  const deletedEntries = []
  store.on('delete-entry', (key) => {
    deletedEntries.push(key)
  })

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  assert.strictEqual(requestsToOrigin, 0)

  {
    // Send initial request. This should reach the origin
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for redis to save the response
  await sleep(1000)

  await store.deleteTags([cacheTag])

  // Wait for redis to emit the event
  await sleep(1000)

  assert.strictEqual(addedEntries.length, 1)
  assert.strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  assert.ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  assert.ok(deletedEntry.id)
  assert.strictEqual(deletedEntry.keyPrefix, keyPrefix)

  assert.strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when invalidates response by cache key', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const keyPrefix = 'foo:bar:'
  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag',
    clientOpts: { keyPrefix }
  })
  await store.subscribe()

  const addedEntries = []
  store.on('add-entry', (entry) => {
    addedEntries.push(entry)
  })

  const deletedEntries = []
  store.on('delete-entry', (key) => {
    deletedEntries.push(key)
  })

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  assert.strictEqual(requestsToOrigin, 0)

  {
    // Send initial request. This should reach the origin
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for redis to save the response
  await sleep(1000)

  await store.deleteKeys([{ origin, method: 'GET', path: '/' }])

  // Wait for redis to emit the event
  await sleep(1000)

  assert.strictEqual(addedEntries.length, 1)
  assert.strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  assert.ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  assert.ok(deletedEntry.id)
  assert.strictEqual(deletedEntry.keyPrefix, keyPrefix)

  assert.strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when cache entry expires', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const keyPrefix = 'foo:bar:'
  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag',
    clientOpts: { keyPrefix }
  })
  await store.subscribe()

  const addedEntries = []
  store.on('add-entry', (entry) => {
    addedEntries.push(entry)
  })

  const deletedEntries = []
  store.on('delete-entry', (key) => {
    deletedEntries.push(key)
  })

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  assert.strictEqual(requestsToOrigin, 0)

  {
    // Send initial request. This should reach the origin
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for cache to expire
  await sleep(5000)

  assert.strictEqual(addedEntries.length, 1)
  assert.strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  assert.ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  assert.ok(deletedEntry.id)
  assert.strictEqual(deletedEntry.keyPrefix, keyPrefix)

  assert.strictEqual(deletedEntry.id, addedEntry.id)
})

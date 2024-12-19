'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const RedisCacheStore = require('../index.js')

test('caches request successfully', async (t) => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore()
  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  const emittedEntries = []
  store.on('write', (entry) => {
    emittedEntries.push(entry)
  })

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

  assert.strictEqual(emittedEntries.length, 1)
  const emittedEntry = emittedEntries[0]
  assert.ok(emittedEntry.id)
  assert.strictEqual(emittedEntry.origin, origin)
  assert.strictEqual(emittedEntry.method, 'GET')
  assert.strictEqual(emittedEntry.path, '/')
  assert.strictEqual(emittedEntry.statusCode, 200)
  assert.ok(emittedEntry.headers)
  assert.ok(emittedEntry.cacheTags)
  assert.ok(emittedEntry.cachedAt)
  assert.ok(emittedEntry.staleAt)
  assert.ok(emittedEntry.deleteAt)
})

test('invalidates response by cache tag', async (t) => {
  let requestsToOrigin = 0

  const cacheTag = 'test-cache-tag-value-42'
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag'
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

  await store.deleteTags([cacheTag])

  {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }
})

test('invalidates response by cache key', async (t) => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag'
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

  await store.deleteKeys([{ origin, method: 'GET', path: '/' }])

  {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }
})

test('invalidates other origin responses with the same cache tag / 2', async (t) => {
  let requestsToOrigin = 0

  const cacheTag = 'test-cache-tag-value-42'
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag'
  })

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  assert.strictEqual(requestsToOrigin, 0)

  // Send initial request. This should reach the origin
  let response = await client.request({
    origin: 'localhost',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 1)
  assert.strictEqual(await response.body.text(), 'asd')

  await sleep(1000)

  // Send second request that should be handled by cache
  response = await client.request({
    origin: 'localhost',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 1)
  assert.strictEqual(await response.body.text(), 'asd')
  assert.strictEqual(response.headers.age, '1')

  // Send third request with different origin that should *not* be handled by cache
  response = await client.request({
    origin: 'my-other-origin',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 2)
  assert.strictEqual(await response.body.text(), 'asd')

  await sleep(1000)

  // Send fourth request that should be handled by cache
  response = await client.request({
    origin: 'my-other-origin',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 2)
  assert.strictEqual(await response.body.text(), 'asd')
  assert.strictEqual(response.headers.age, '1')

  await store.deleteKeys([{
    origin: 'localhost',
    method: 'GET',
    path: '/'
  }])

  // Send fifth request that should reach the origin again
  response = await client.request({
    origin: 'localhost',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 3)
  assert.strictEqual(await response.body.text(), 'asd')

  await sleep(1000)

  // Send sixth request with different origin that should *not* be handled by cache
  response = await client.request({
    origin: 'my-other-origin',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 4)
  assert.strictEqual(await response.body.text(), 'asd')

  await sleep(1000)

  // Send seventh request with different origin that should be handled by cache
  response = await client.request({
    origin: 'my-other-origin',
    method: 'GET',
    path: '/'
  })
  assert.strictEqual(requestsToOrigin, 4)
  assert.strictEqual(await response.body.text(), 'asd')
})

test('invalidates GET cache by making POST to the same url', async (t) => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag'
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
      origin, method: 'GET', path: '/foo'
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
      origin, method: 'GET', path: '/foo'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
    assert.strictEqual(headers.age, '1')
  }

  {
    // Send POST request that should invalidate the cache
    const { statusCode, body } = await client.request({
      origin, method: 'POST', path: '/foo'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for redis to invalidate the cache
  await sleep(1000)

  {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/foo'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 3)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }
})

test('should not invalidate GET cache by making POST to the _different_ url', async (t) => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore({
    cacheTagsHeader: 'cache-tag'
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
      origin, method: 'GET', path: '/foo'
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
      origin, method: 'GET', path: '/foo'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
    assert.strictEqual(headers.age, '1')
  }

  {
    // Send POST request that should invalidate the cache
    const { statusCode, body } = await client.request({
      origin, method: 'POST', path: '/bar'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }

  // Wait for redis to invalidate the cache
  await sleep(1000)

  {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin, method: 'GET', path: '/foo'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    assert.strictEqual(text, 'asd')
  }
})

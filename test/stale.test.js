// @ts-check
'use strict'

const { test, beforeEach } = require('node:test')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { RedisCacheStore } = require('../lib/redis-cache-store')
const { createServer } = require('node:http')
const { Client, interceptors } = require('undici')
const { Redis } = require('iovalkey')

beforeEach(async (t) => {
  const client = new Redis()
  await client.flushall()
  await client.quit()
})

/**
 * Creates a deferred promise that can be resolved/rejected externally
 * @returns {{ promise: Promise<void>, resolve: () => void, reject: (err: Error) => void }}
 */
function createDeferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

for (const maxAgeHeader of ['s-maxage', 'max-age']) {
  test(`stale-while-revalidate w/ ${maxAgeHeader}`, async (t) => {
    const store = new RedisCacheStore()
    let requestsToOrigin = 0
    let revalidationRequests = 0
    const revalidationDeferred = createDeferred()
    const server = createServer((req, res) => {
      if (req.headers['if-none-match']) {
        revalidationRequests++
        if (req.headers['if-none-match'] !== '"asd"') {
          t.assert.fail(`etag mismatch: ${req.headers['if-none-match']}`)
        }

        res.statusCode = 304
        res.end()
        revalidationDeferred.resolve()
      } else {
        requestsToOrigin++
        res.setHeader('cache-control', 'public, max-age=1, stale-while-revalidate=4')
        res.setHeader('etag', '"asd"')
        res.end('asd')
      }
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({
        store
      }))

    t.after(async () => {
      server.close()
      await client.close()
      await store.close()
    })

    await once(server, 'listening')

    t.assert.strictEqual(requestsToOrigin, 0)
    t.assert.strictEqual(revalidationRequests, 0)

    // Send first request, this will hit the origin
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      t.assert.equal(requestsToOrigin, 1)
      t.assert.strictEqual(revalidationRequests, 0)
      t.assert.equal(response.statusCode, 200)
      t.assert.equal(await response.body.text(), 'asd')
    }

    // We need to sleep for a bit to let the cache entry
    // be saved in Valkey
    await once(store, 'write')

    // Send second request, this will be cached.
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      t.assert.equal(requestsToOrigin, 1)
      t.assert.strictEqual(revalidationRequests, 0)
      t.assert.equal(response.statusCode, 200)
      t.assert.equal(await response.body.text(), 'asd')
    }

    await sleep(1500)

    // Send third request, this should be revalidated
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      t.assert.equal(requestsToOrigin, 1)
      t.assert.equal(response.statusCode, 200)
      t.assert.equal(await response.body.text(), 'asd')

      // Wait for the background revalidation request to reach the server
      // stale-while-revalidate serves the stale response immediately
      // and triggers a background revalidation request asynchronously
      await revalidationDeferred.promise
      t.assert.strictEqual(revalidationRequests, 1)
    }

    await sleep(6000)

    // Send fourth request, this should be a new request entirely
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      t.assert.equal(requestsToOrigin, 2)
      t.assert.strictEqual(revalidationRequests, 1)
      t.assert.equal(response.statusCode, 200)
      t.assert.equal(await response.body.text(), 'asd')
    }
  })
}

test('stale-while-revalidate 304 should refresh the cache entry', async (t) => {
  const store = new RedisCacheStore()
  let requestsToOrigin = 0
  let revalidationRequests = 0
  const revalidationDeferred = createDeferred()

  const server = createServer((req, res) => {
    if (req.headers['if-none-match']) {
      revalidationRequests++
      if (req.headers['if-none-match'] !== '"test-etag"') {
        t.assert.fail(`etag mismatch: ${req.headers['if-none-match']}`)
      }
      res.statusCode = 304
      res.setHeader('cache-control', 'public, s-maxage=10, stale-while-revalidate=100')
      res.end()
      revalidationDeferred.resolve()
    } else {
      requestsToOrigin++
      res.setHeader('cache-control', 'public, s-maxage=1, stale-while-revalidate=100')
      res.setHeader('etag', '"test-etag"')
      res.end('cached-body')
    }
  }).listen(0)

  const client = new Client(`http://localhost:${server.address().port}`)
    .compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
    await store.close()
  })

  await once(server, 'listening')

  // First request: hits origin, response gets cached
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 1)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'cached-body')
  }

  await once(store, 'write')

  // Wait for the entry to become stale (s-maxage=1)
  await sleep(1500)

  // Second request: entry is stale, served with warning + background revalidation
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 1)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'cached-body')
    t.assert.ok(response.headers.warning, 'Expected stale warning')
  }

  // Wait for the background revalidation (304) to complete
  await revalidationDeferred.promise
  t.assert.strictEqual(revalidationRequests, 1)

  // Wait for the cache entry to be updated in Redis
  await sleep(500)

  // Third request: after 304 revalidation, the cache should be refreshed.
  // The 304 response has s-maxage=10, so the entry should be fresh for 10s.
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 1)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'cached-body')

    // After a successful 304 revalidation, the cache entry should be fresh.
    // If the entry was NOT refreshed (bug), it will still be stale with a warning.
    t.assert.strictEqual(
      response.headers.warning,
      undefined,
      'Expected response to be fresh after 304 revalidation, but got stale warning'
    )
  }
})

test('stale-if-error from response works as expected', async (t) => {
  const store = new RedisCacheStore()

  let requestsToOrigin = 0
  const server = createServer((_, res) => {
    requestsToOrigin++
    if (requestsToOrigin === 1) {
      // First request
      res.setHeader('cache-control', 'public, s-maxage=4, stale-if-error=4')
      res.end('asd')
    } else {
      res.statusCode = 500
      res.end('')
    }
  }).listen(0)

  const client = new Client(`http://localhost:${server.address().port}`)
    .compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
    await store.close()
  })

  await once(server, 'listening')

  t.assert.strictEqual(requestsToOrigin, 0)

  // Send first request. This will hit the origin and succeed
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 1)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'asd')
  }

  await once(store, 'write')

  // Send second request. It isn't stale yet, so this should be from the
  //  cache and succeed
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 1)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'asd')
  }

  await sleep(5000)

  // Send third request. This is now stale, the revalidation request should
  //  fail but the response should still be served from cache.
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 2)
    t.assert.equal(response.statusCode, 200)
    t.assert.equal(await response.body.text(), 'asd')
  }

  await sleep(5000)

  // Send fourth request. We're now outside the stale-if-error threshold and
  //  should see the error.
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    t.assert.equal(requestsToOrigin, 3)
    t.assert.equal(response.statusCode, 500)
  }
})

'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const RedisCacheStore = require('../index.js')

// test('caches request successfully', async (t) => {
//   let requestsToOrigin = 0

//   const server = createServer((_, res) => {
//     requestsToOrigin++
//     res.setHeader('cache-control', 'public, s-maxage=10')
//     res.end('asd')
//   }).listen(0)

//   const store = new RedisCacheStore()
//   const origin = `http://localhost:${server.address().port}`
//   const client = new Client(origin).compose(interceptors.cache({ store }))

//   t.after(async () => {
//     server.close()
//     await store.close()
//     await client.close()
//   })

//   await once(server, 'listening')

//   assert.strictEqual(requestsToOrigin, 0)

//   {
//     const { statusCode, body } = await client.request({
//       origin, method: 'GET', path: '/'
//     })
//     assert.strictEqual(statusCode, 200)
//     assert.strictEqual(requestsToOrigin, 1)

//     const text = await body.text()
//     assert.strictEqual(text, 'asd')
//   }

//   // Wait for redis to save the response
//   await sleep(1000)

//   {
//     // Send second request that should be handled by cache
//     const { statusCode, body, headers } = await client.request({
//       origin, method: 'GET', path: '/'
//     })
//     assert.strictEqual(statusCode, 200)
//     assert.strictEqual(requestsToOrigin, 1)

//     const text = await body.text()
//     assert.strictEqual(text, 'asd')

//     assert.strictEqual(headers.age, '1')
//   }
// })

// test('invalidates response by cache tag', async (t) => {
//   let requestsToOrigin = 0

//   const cacheTag = 'test-cache-tag-value-42'
//   const server = createServer((_, res) => {
//     requestsToOrigin++
//     res.setHeader('cache-control', 'public, s-maxage=10')
//     res.setHeader('cache-tag', cacheTag)
//     res.end('asd')
//   }).listen(0)

//   await once(server, 'listening')

//   const store = new RedisCacheStore({
//     cacheTagsHeader: 'cache-tag'
//   })

//   const origin = `http://localhost:${server.address().port}`
//   const client = new Client(origin).compose(interceptors.cache({ store }))

//   t.after(async () => {
//     server.close()
//     await store.close()
//     await client.close()
//   })

//   assert.strictEqual(requestsToOrigin, 0)

//   {
//     // Send initial request. This should reach the origin
//     const { statusCode, body } = await client.request({
//       origin, method: 'GET', path: '/'
//     })
//     assert.strictEqual(statusCode, 200)
//     assert.strictEqual(requestsToOrigin, 1)

//     const text = await body.text()
//     assert.strictEqual(text, 'asd')
//   }

//   // Wait for redis to save the response
//   await sleep(1000)

//   {
//     // Send second request that should be handled by cache
//     const { statusCode, body, headers } = await client.request({
//       origin, method: 'GET', path: '/'
//     })
//     assert.strictEqual(statusCode, 200)
//     assert.strictEqual(requestsToOrigin, 1)

//     const text = await body.text()
//     assert.strictEqual(text, 'asd')
//     assert.strictEqual(headers.age, '1')
//   }

//   await store.deleteTags([cacheTag])

//   {
//     // Send third request that should reach the origin again
//     const { statusCode, body } = await client.request({
//       origin, method: 'GET', path: '/'
//     })
//     assert.strictEqual(statusCode, 200)
//     assert.strictEqual(requestsToOrigin, 2)

//     const text = await body.text()
//     assert.strictEqual(text, 'asd')
//   }
// })

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

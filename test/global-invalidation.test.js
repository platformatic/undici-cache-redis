'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const { RedisCacheStore, RedisCacheManager } = require('../index.js')
const { cleanValkey } = require('./helper.js')

test('should stream cache entries', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const server = createServer((req, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=100')
    res.setHeader('cache-tags', req.headers['cache-tags'])
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')
  t.after(() => server.close())

  const origin = `http://localhost:${server.address().port}`

  const keyPrefix1 = 'foo:bar:1:'
  const store1 = new RedisCacheStore({
    clientOpts: { keyPrefix: keyPrefix1 },
    cacheTagsHeader: 'cache-tags'
  })
  {
    // Make requests from the first client
    const client = new Client(origin).compose(interceptors.cache({ store: store1 }))

    t.after(async () => {
      await store1.close()
      await client.close()
    })

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/foo', headers: { 'cache-tags': 'tag1,tag2' }
      })
      assert.strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/bar', headers: { 'cache-tags': 'tag1,tag2,tag4' }
      })
      assert.strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/bak', headers: { 'cache-tags': 'tag1,tag3,tag5' }
      })
      assert.strictEqual(statusCode, 200)
    }
  }

  const keyPrefix2 = 'foo:bar:2:'
  const store2 = new RedisCacheStore({
    clientOpts: { keyPrefix: keyPrefix2 },
    cacheTagsHeader: 'cache-tags'
  })
  {
    // Make requests from the second client
    const client = new Client(origin).compose(interceptors.cache({ store: store2 }))

    t.after(async () => {
      await store2.close()
      await client.close()
    })

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/baz', headers: { 'cache-tags': 'tag1,tag2' }
      })
      assert.strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/boa', headers: { 'cache-tags': 'tag2,tag1,tag6' }
      })
      assert.strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin, method: 'GET', path: '/bov', headers: { 'cache-tags': 'tag3,tag1,tag7' }
      })
      assert.strictEqual(statusCode, 200)
    }
  }

  assert.strictEqual(requestsToOrigin, 6)

  // Wait for redis to save the response
  await sleep(1000)

  // Getting all request from the manager
  const manager = new RedisCacheManager({ configureKeyspaceEventNotification: true })
  await manager.subscribe()
  t.after(() => manager.close())

  await store1.deleteTags([['tag1', 'tag2']])

  const foundEntries = []
  await manager.streamEntries(entry => foundEntries.push(entry), '*')
  assert.strictEqual(foundEntries.length, 2)

  const entriesCacheTags = foundEntries.map(entry => entry.headers['cache-tags'])
  assert.deepStrictEqual(entriesCacheTags.sort(), [
    'tag1,tag3,tag5',
    'tag3,tag1,tag7'
  ].sort())
})

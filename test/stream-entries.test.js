'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const { RedisCacheStore, RedisCacheManager } = require('../index.js')
const { cleanValkey } = require('./helper.js')

test('should stream all cache entries', async (t) => {
  await cleanValkey()

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')
  t.after(() => server.close())

  const origin = `http://localhost:${server.address().port}`

  {
    // Make a request from the first client
    const keyPrefix = 'foo:bar:1:'
    const store = new RedisCacheStore({ clientOpts: { keyPrefix } })
    const client = new Client(origin).compose(interceptors.cache({ store }))

    t.after(async () => {
      await store.close()
      await client.close()
    })

    const { statusCode } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
  }

  {
    // Make a request from the second client
    const keyPrefix = 'foo:bar:2:'
    const store = new RedisCacheStore({ clientOpts: { keyPrefix } })
    const client = new Client(origin).compose(interceptors.cache({ store }))

    t.after(async () => {
      await store.close()
      await client.close()
    })

    const { statusCode } = await client.request({
      origin, method: 'GET', path: '/'
    })
    assert.strictEqual(statusCode, 200)
  }

  assert.strictEqual(requestsToOrigin, 2)

  // Wait for redis to save the response
  await sleep(1000)

  // Getting all request from the manager
  const manager = new RedisCacheManager()
  t.after(() => manager.close())

  const foundEntries = []
  await manager.streamEntries((entries) => {
    foundEntries.push(...entries)
  })

  assert.strictEqual(foundEntries.length, 2)
})

'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('node:http')
const { Client, interceptors } = require('undici')
const { RedisCacheManager, RedisCacheStore } = require('../index.js')
const { cleanValkey } = require('./helper.js')

test('cache manager works when notify-keyspace-events is configured on the server', async (t) => {
  await cleanValkey()

  const manager = new RedisCacheManager({
    clientConfigKeyspaceEventNotify: false,
    clientOpts: { url: 'http://localhost:6389' }
  })
  await manager.subscribe()

  t.after(async () => {
    await manager.close()
  })
})

test('cache manager fails when notify-keyspace-events is NOT configured on the server', async (t) => {
  await cleanValkey()

  const manager = new RedisCacheManager({
    clientConfigKeyspaceEventNotify: true,
    clientOpts: { host: 'localhost', port: 6399 }
  })

  await assert.rejects(manager.subscribe)
  t.after(async () => {
    await manager.close()
  })
})

test.only('invalidates response from cache manager', async (t) => {
  await cleanValkey()

  const manager = new RedisCacheManager()
  await manager.subscribe()
  t.after(() => manager.close())

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const store = new RedisCacheStore()

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

  const foundEntries = []
  await manager.streamEntries(entry => {
    foundEntries.push(entry)
  })

  const foundEntity = foundEntries[0]
  assert.ok(foundEntity.id)

  await manager.deleteIds([foundEntity.id])
  await sleep(1000)

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


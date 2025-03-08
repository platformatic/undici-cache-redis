'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { RedisCacheManager } = require('../index.js')
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

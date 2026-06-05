import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey } from '../../helper.js'
import { createCachedServer } from './helper.js'

test('v2 cache manager subscribes when notify-keyspace-events is configured on the server', async t => {
  await cleanValkey()
  const manager = new RedisCache({ clientConfigKeyspaceEventNotify: false, clientOpts: { url: 'http://localhost:6389' } })
  t.after(() => manager.close())

  await manager.subscribe()
})

test('v2 cache manager fails when notify-keyspace-events is not configured on the server', async t => {
  const manager = new RedisCache({ clientConfigKeyspaceEventNotify: true, clientOpts: { host: 'localhost', port: 6399 } })
  t.after(() => manager.close())

  await assert.rejects(manager.subscribe())
})

test('v2 cache manager invalidates response by id', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const fixture = await createCachedServer(t, { prefix })

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await sleep(1000)
  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  assert.equal(fixture.requests, 1)

  const entries = await fixture.store.entries({}, prefix)
  assert.equal(entries.length, 1)
  await fixture.store.deleteIds([entries[0].id], prefix)

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  assert.equal(fixture.requests, 2)
})

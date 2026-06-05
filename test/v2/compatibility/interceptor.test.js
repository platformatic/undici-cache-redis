import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { cleanValkey } from '../../helper.js'
import { createCachedServer } from './helper.js'

test('v2 caches request successfully through undici interceptor', async t => {
  await cleanValkey()
  const fixture = await createCachedServer(t)

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await sleep(1000)
  const second = await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' })

  assert.equal(await second.body.text(), 'asd')
  assert.equal(fixture.requests, 1)
  assert.ok(second.headers.age)
})

test('v2 invalidates response by cache tag through undici interceptor', async t => {
  await cleanValkey()
  const fixture = await createCachedServer(t, { cacheTagsHeader: 'cache-tag', cacheTags: 'tag1' })

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await sleep(1000)
  await fixture.store.deleteTags(['tag1'])
  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())

  assert.equal(fixture.requests, 2)
})

test('v2 invalidates GET cache by making POST to the same url', async t => {
  await cleanValkey()
  const fixture = await createCachedServer(t)

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await fixture.client.request({ origin: fixture.origin, method: 'POST', path: '/', body: 'mutate' }).then(({ body }) => body.text())
  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())

  assert.equal(fixture.requests, 3)
})

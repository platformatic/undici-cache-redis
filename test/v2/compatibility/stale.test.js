import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { cleanValkey } from '../../helper.js'
import { createCachedServer } from './helper.js'

test('v2 serves stale response while revalidating', async t => {
  await cleanValkey()
  const fixture = await createCachedServer(t, { cacheControl: 'public, s-maxage=1, stale-while-revalidate=5' })

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await sleep(1200)
  const stale = await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' })

  assert.equal(await stale.body.text(), 'asd')
  assert.equal(fixture.requests, 1)
})

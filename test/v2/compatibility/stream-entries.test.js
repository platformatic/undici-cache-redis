import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { cleanValkey } from '../../helper.js'
import { createCachedServer } from './helper.js'

test('v2 streamEntries streams cache entries for a prefix', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const fixture = await createCachedServer(t, { prefix, cacheTagsHeader: 'x-cache-tags', cacheTags: 'tag1,tag2' })

  await fixture.client.request({ origin: fixture.origin, method: 'GET', path: '/' }).then(({ body }) => body.text())
  await sleep(1000)

  const entries = []
  await fixture.store.streamEntries(entry => entries.push(entry), prefix)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].prefix, prefix)
  assert.deepEqual(entries[0].cacheTags, ['tag1', 'tag2'])
})

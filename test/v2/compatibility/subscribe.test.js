import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey } from '../../helper.js'
import { cacheValue, writeEntry } from './helper.js'

test('v2 subscription notifies when a new key is added', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const cache = new RedisCache({ prefix, tracking: false, cacheTagsHeader: 'cache-tags' })
  t.after(() => cache.close())

  await cache.subscribe(prefix)
  const event = once(cache, 'subscription:entry:add')
  await writeEntry(cache, { origin: 'http://example.com', method: 'GET', path: '/' }, cacheValue({ headers: { 'cache-tags': 'tag1,tag2' } }), 'asd')

  const [entry] = await event
  assert.ok(entry.id)
  assert.equal(entry.prefix, prefix)
  assert.deepEqual(entry.metadata.tags, ['tag1', 'tag2'])
})

test('v2 subscription notifies when an entry is deleted', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const cache = new RedisCache({ prefix, tracking: false })
  t.after(() => cache.close())

  const key = { origin: 'http://example.com', method: 'GET', path: '/' }
  await writeEntry(cache, key, cacheValue(), 'asd')
  const entries = await cache.entries({}, prefix)

  await cache.subscribe(prefix)
  const event = once(cache, 'subscription:entry:delete')
  await cache.deleteIds([entries[0].id], prefix)

  const [entry] = await event
  assert.equal(entry.id, entries[0].id)
  assert.equal(entry.prefix, prefix)
})

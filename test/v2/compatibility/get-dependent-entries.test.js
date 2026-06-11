import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey } from '../../helper.js'
import { cacheValue, writeEntry } from './helper.js'

test('v2 getDependentEntries returns entries sharing cache tags', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const cache = new RedisCache({ prefix, tracking: false, cacheTagsHeader: 'cache-tags' })
  t.after(() => cache.close())

  await writeEntry(cache, { origin: 'http://example.com', method: 'GET', path: '/foo' }, cacheValue({ headers: { 'cache-tags': 'tag1,tag2' } }), 'foo')
  await writeEntry(cache, { origin: 'http://example.com', method: 'GET', path: '/bar' }, cacheValue({ headers: { 'cache-tags': 'tag1,tag2,tag3' } }), 'bar')

  const entries = await cache.entries({}, prefix)
  const source = entries.find(entry => entry.path === '/foo')
  assert.ok(source)
  const dependent = await cache.getDependentEntries(source.id, prefix)

  assert.equal(dependent.length, 1)
  assert.deepEqual(dependent.map(entry => entry.path), ['/bar'])
})

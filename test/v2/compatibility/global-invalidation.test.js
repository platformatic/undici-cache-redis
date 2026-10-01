import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey } from '../../helper.js'
import { cacheValue, writeEntry } from './helper.js'

test('v2 invalidates same-tag responses across cache instances', async t => {
  await cleanValkey()
  const prefix = `${crypto.randomUUID()}:`
  const cacheA = new RedisCache({ prefix, tracking: false, cacheTagsHeader: 'cache-tags' })
  const cacheB = new RedisCache({ prefix, tracking: false, cacheTagsHeader: 'cache-tags' })
  t.after(async () => {
    await cacheA.close()
    await cacheB.close()
  })

  const key = { origin: 'http://example.com', method: 'GET', path: '/foo' }
  await writeEntry(cacheA, key, cacheValue({ headers: { 'cache-tags': 'shared' } }), 'foo')
  assert.notEqual(await cacheB.get(key), undefined)

  await cacheB.deleteTags(['shared'], prefix)
  assert.equal(await cacheA.get(key), undefined)
})

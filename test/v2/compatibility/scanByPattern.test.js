import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey, getAllKeys } from '../../helper.js'
import { cacheValue, writeEntry } from './helper.js'

test('v2 compatibility lookup uses indexed data instead of scan-backed metadata keys', async t => {
  await cleanValkey()
  const cache = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
  t.after(() => cache.close())

  await writeEntry(cache, { origin: 'http://example.com', method: 'GET', path: '/' }, cacheValue(), 'asd')

  const result = await cache.get({ origin: 'http://example.com', method: 'GET', path: '/' })
  assert.notEqual(result, undefined)

  const keys = await getAllKeys()
  assert.equal(keys.some(key => key.includes('metadata:')), false)
})

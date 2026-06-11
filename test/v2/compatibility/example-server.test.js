import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'

test('v2 example compatibility exposes default RedisCache constructor', async t => {
  const cache = new RedisCache({ tracking: false })
  t.after(() => cache.close())

  assert.equal(typeof cache.get, 'function')
  assert.equal(typeof cache.entries, 'function')
})

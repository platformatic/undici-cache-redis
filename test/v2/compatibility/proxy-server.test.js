import assert from 'node:assert/strict'
import { Agent, interceptors } from 'undici'
import { test } from 'node:test'
import { RedisCache } from '../../../index.js'

test('v2 proxy compatibility creates an undici agent with the default cache store', async t => {
  const store = new RedisCache({ tracking: false })
  const agent = new Agent().compose(interceptors.cache({ store }))
  t.after(async () => {
    await agent.close()
    await store.close()
  })

  assert.ok(agent)
})

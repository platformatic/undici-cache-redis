import { ok, rejects, strictEqual } from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, interceptors } from 'undici'
import type { CacheValueWithAdditionalProperties } from '../../src/types.ts'
import { createManager, createStore, preparePrefix, setVersion, waitForEvents } from '../helper.ts'

setVersion('2.0.0')

test('cache manager works when notify-keyspace-events is configured on the server', async t => {
  const prefix = await preparePrefix(t, undefined, { port: 7002 })

  const manager = await createManager(t, { prefix, clientConfigKeyspaceEventNotify: true, clientOpts: { port: 7002 } })
  await manager.subscribe()
})

test('cache manager fails when notify-keyspace-events is NOT configured on the server', async t => {
  const prefix = await preparePrefix(t, undefined, { port: 7003 })

  const manager = await createManager(t, { prefix, clientConfigKeyspaceEventNotify: true, clientOpts: { port: 7003 } })
  await rejects(manager.subscribe)
})

test('invalidates response from cache manager', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  // In the ICC we use RedisCacheManager without any keyPrefix to have a single
  // instance for all applications
  const manager = await createManager(t)
  await manager.subscribe()

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
  })

  strictEqual(requestsToOrigin, 0)

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Send initial request. This should reach the origin
    const { statusCode, body } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    strictEqual(text, 'asd')
  })

  await sleep(1000) // This is to set the age header correctly

  {
    // Send second request that should be handled by cache
    const { statusCode, body, headers } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    strictEqual(text, 'asd')
    strictEqual(headers.age, '1')
  }

  const foundEntries: CacheValueWithAdditionalProperties[] = []
  await manager.streamEntries(entry => foundEntries.push(entry), prefix)
  strictEqual(foundEntries.length, 1)

  const foundEntity = foundEntries[0]
  ok(foundEntity.id)

  await waitForEvents(manager, 'entry:delete', 1, () => manager.deleteIds([foundEntity.id], prefix))

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    strictEqual(text, 'asd')
  })
})

import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, interceptors } from 'undici'
import type { CacheEntry } from '../../src/types.ts'
import {
  createManager,
  createStore,
  createTags,
  createTagsHeader,
  listTags,
  preparePrefix,
  setVersion
} from '../helper.ts'

setVersion('1.0.0')

test('should stream cache entries', async t => {
  const tags = createTags(7)
  const prefix1 = await preparePrefix(t)
  const prefix2 = await preparePrefix(t)

  let requestsToOrigin = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=100')
    res.setHeader('cache-tags', req.headers['cache-tags']!)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')
  t.after(() => server.close())

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`

  const store1 = await createStore(t, { prefix: prefix1, cacheTagsHeader: 'cache-tags' })

  {
    // Make requests from the first client
    const client = new Client(origin).compose(interceptors.cache({ store: store1 }))

    t.after(async () => {
      await store1.close()
      await client.close()
    })

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/foo',
        headers: { 'cache-tags': createTagsHeader(tags, 1, 2) }
      })
      strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/bar',
        headers: { 'cache-tags': createTagsHeader(tags, 1, 2, 4) }
      })
      strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/bak',
        headers: { 'cache-tags': createTagsHeader(tags, 1, 3, 5) }
      })
      strictEqual(statusCode, 200)
    }
  }

  const store2 = await createStore(t, { prefix: prefix2, cacheTagsHeader: 'cache-tags' })

  {
    // Make requests from the second client
    const client = new Client(origin).compose(interceptors.cache({ store: store2 }))

    t.after(async () => {
      await store2.close()
      await client.close()
    })

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/baz',
        headers: { 'cache-tags': createTagsHeader(tags, 1, 2) }
      })
      strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/boa',
        headers: { 'cache-tags': createTagsHeader(tags, 2, 1, 6) }
      })
      strictEqual(statusCode, 200)
    }

    {
      const { statusCode } = await client.request({
        origin,
        method: 'GET',
        path: '/bov',
        headers: { 'cache-tags': createTagsHeader(tags, 3, 1, 7) }
      })
      strictEqual(statusCode, 200)
    }
  }

  strictEqual(requestsToOrigin, 6)

  // Wait for redis to save the response
  await sleep(1000)

  // Getting all request from the manager
  const manager = await createManager(t)
  await manager.subscribe()
  t.after(() => manager.close())

  await store1.deleteTags([listTags(tags, 1, 2)])

  const foundEntries: CacheEntry[] = []
  await manager.streamEntries(entry => foundEntries.push(entry), [prefix1, prefix2])
  strictEqual(foundEntries.length, 2)

  const entriesCacheTags = foundEntries.map(entry => entry.headers['cache-tags'])
  deepStrictEqual(entriesCacheTags.sort(), [createTagsHeader(tags, 1, 3, 5), createTagsHeader(tags, 3, 1, 7)].sort())
})

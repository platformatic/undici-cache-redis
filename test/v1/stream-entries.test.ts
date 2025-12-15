import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
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
  const tags = createTags(2)
  const prefix1 = await preparePrefix(t)
  const prefix2 = await preparePrefix(t)

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('x-cache-tags', createTagsHeader(tags, 1, 2))
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')
  t.after(() => server.close())

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`

  {
    // Make a request from the first client
    const store = await createStore(t, { prefix: prefix1, cacheTagsHeader: 'x-cache-tags' })
    const client = new Client(origin).compose(interceptors.cache({ store }))

    t.after(async () => {
      await store.close()
      await client.close()
    })

    const { statusCode } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
  }

  {
    const store = await createStore(t, { prefix: prefix2 })

    // Make a request from the second client
    const client = new Client(origin).compose(interceptors.cache({ store }))

    t.after(async () => {
      await store.close()
      await client.close()
    })

    const { statusCode } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
  }

  strictEqual(requestsToOrigin, 2)

  // Wait for redis to save the response
  await sleep(1000)

  // Getting all request from the manager
  const manager = await createManager(t)
  t.after(() => manager.close())

  const foundEntries: CacheEntry[] = []
  await manager.streamEntries(entry => foundEntries.push(entry), prefix1)

  strictEqual(foundEntries.length, 1)

  const foundEntry = foundEntries[0]
  strictEqual(foundEntry.keyPrefix, prefix1)
  strictEqual(foundEntry.origin, origin)
  strictEqual(foundEntry.method, 'GET')
  strictEqual(foundEntry.path, '/')
  deepStrictEqual(foundEntry.cacheTags, listTags(tags, 1, 2).sort())
  strictEqual(typeof foundEntry.id, 'string')
  strictEqual(typeof foundEntry.headers, 'object')
  strictEqual(typeof foundEntry.cachedAt, 'number')
  strictEqual(typeof foundEntry.staleAt, 'number')
  strictEqual(typeof foundEntry.deleteAt, 'number')

  const response = await manager.getResponseById(foundEntry.id, prefix1)
  strictEqual(response, 'asd')
})

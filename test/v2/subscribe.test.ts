import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, interceptors } from 'undici'
import type { AddedCacheEntry } from '../../src/v2/types.ts'
import {
  createManager,
  createStore,
  createTags,
  createTagsHeader,
  getStorageKeys,
  listTags,
  preparePrefix,
  setVersion,
  waitForCleanup,
  waitForEvents
} from '../helper.ts'

setVersion('2.0.0')

test('should notify when a new key is added', async t => {
  const tags = createTags(2)
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix, cacheTagsHeader: 'x-cache-tags' })
  const manager = await createManager(t, { prefix })

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('x-cache-tags', createTagsHeader(tags, 1, 2))
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  await manager.subscribe()

  const addedEntries: AddedCacheEntry[] = []
  manager.on('subscription:entry:add', entry => {
    // This might happen if test suite is run in parallel
    if (entry.prefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
  })

  strictEqual(requestsToOrigin, 0)

  await waitForEvents(store, 'entry:write', 1, async () => {
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

  strictEqual(addedEntries.length, 1)

  const newEntry = addedEntries[0]
  ok(newEntry.id)
  strictEqual(newEntry.value.statusCode, 200)
  ok(newEntry.value.headers)
  strictEqual(typeof newEntry.value.cachedAt, 'number')
  strictEqual(typeof newEntry.value.deleteAt, 'number')
  strictEqual(newEntry.metadata.prefix, prefix)
  strictEqual(newEntry.metadata.origin, origin)
  strictEqual(newEntry.metadata.path, '/')
  strictEqual(newEntry.metadata.method, 'GET')
  deepStrictEqual(newEntry.metadata.tags, listTags(tags, 1, 2).sort())
})

test('should notify when invalidates response by cache tag', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })
  const manager = await createManager(t, { prefix })

  let requestsToOrigin = 0

  const cacheTag = randomBytes(8).toString('hex')
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=100')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const addedEntries: AddedCacheEntry[] = []
  manager.on('subscription:entry:add', entry => {
    // This might happen if test suite is run in parallel
    if (entry.prefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: { id: string; prefix: string }[] = []
  manager.on('subscription:entry:delete', entry => {
    if (entry.prefix === prefix) {
      deletedEntries.push(entry)
    }
  })

  await manager.subscribe()

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

  await waitForCleanup(store, [{ prefix, type: 'tags', target: cacheTag }], async () => store.deleteTags([cacheTag]))

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.prefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when invalidates response by cache key', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })
  const manager = await createManager(t, { prefix })

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  await manager.subscribe()

  const addedEntries: AddedCacheEntry[] = []
  manager.on('subscription:entry:add', entry => {
    // This might happen if test suite is run in parallel
    if (entry.prefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: { id: string; prefix: string }[] = []
  manager.on('subscription:entry:delete', entry => {
    if (entry.prefix === prefix) {
      deletedEntries.push(entry)
    }
  })

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

  await waitForCleanup(
    store,
    [{ prefix, type: 'key', target: getStorageKeys({ origin, method: 'GET', path: '/' }, prefix).request }],
    async () => store.deleteKeys([{ origin, method: 'GET', path: '/' }])
  )

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.prefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when cache entry expires', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })
  const manager = await createManager(t, { prefix })

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1, stale-while-revalidate=1, stale-if-error=1')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  await manager.subscribe()

  const addedEntries: AddedCacheEntry[] = []
  manager.on('subscription:entry:add', entry => {
    // This might happen if test suite is run in parallel
    if (entry.prefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: { id: string; prefix: string }[] = []
  manager.on('subscription:entry:delete', entry => {
    if (entry.prefix === prefix) {
      deletedEntries.push(entry)
    }
  })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
    await manager.close()
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

  // Wait for cache to expire
  await once(manager, 'subscription:entry:delete')

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.prefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

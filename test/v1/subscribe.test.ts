import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
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

test('should notify when a new key is added', async t => {
  const tags = createTags(2)
  const prefix = await preparePrefix(t)

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('x-cache-tags', createTagsHeader(tags, 1, 2))
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const manager = await createManager(t)
  await manager.subscribe()

  const addedEntries: CacheEntry[] = []
  manager.on('add-entry', entry => {
    // This might happen if test suite is run in parallel
    if (entry.keyPrefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const store = await createStore(t, { prefix, cacheTagsHeader: 'x-cache-tags' })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
    await manager.close()
  })

  strictEqual(requestsToOrigin, 0)

  {
    const { statusCode, body } = await client.request({
      origin,
      method: 'GET',
      path: '/'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    strictEqual(text, 'asd')
  }

  // Wait for redis to save the response
  await sleep(1000)

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
  strictEqual(newEntry.keyPrefix, prefix)
  strictEqual(newEntry.origin, origin)
  strictEqual(newEntry.path, '/')
  strictEqual(newEntry.method, 'GET')
  strictEqual(newEntry.statusCode, 200)
  deepStrictEqual(newEntry.cacheTags, listTags(tags, 1, 2).sort())
  ok(newEntry.headers)
  strictEqual(typeof newEntry.cachedAt, 'number')
  strictEqual(typeof newEntry.deleteAt, 'number')
})

test('should notify when invalidates response by cache tag', async t => {
  const prefix = await preparePrefix(t)

  let requestsToOrigin = 0

  const cacheTag = randomBytes(8).toString('hex')
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=100')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const manager = await createManager(t)

  const addedEntries: CacheEntry[] = []
  manager.on('add-entry', entry => {
    if (entry.keyPrefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: CacheEntry[] = []
  manager.on('delete-entry', entry => {
    if (entry.keyPrefix === prefix) {
      deletedEntries.push(entry)
    }
  })

  await manager.subscribe()

  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
    await manager.close()
  })

  strictEqual(requestsToOrigin, 0)

  {
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
  }

  // Wait for redis to save the response
  await sleep(1000)

  await store.deleteTags([cacheTag])

  // Wait for redis to emit the event
  await sleep(1000)

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.keyPrefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when invalidates response by cache key', async t => {
  const prefix = await preparePrefix(t)

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const manager = await createManager(t, { prefix })
  await manager.subscribe()

  const addedEntries: CacheEntry[] = []
  manager.on('add-entry', entry => {
    if (entry.keyPrefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: CacheEntry[] = []
  manager.on('delete-entry', entry => {
    if (entry.keyPrefix === prefix) {
      deletedEntries.push(entry)
    }
  })

  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
    await manager.close()
  })

  strictEqual(requestsToOrigin, 0)

  {
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
  }

  // Wait for redis to save the response
  await sleep(1000)

  await store.deleteKeys([{ origin, method: 'GET', path: '/' }])

  // Wait for redis to emit the event
  await sleep(1000)

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.keyPrefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

test('should notify when cache entry expires', async t => {
  const prefix = await preparePrefix(t)

  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=1, stale-while-revalidate=1, stale-if-error=1')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const manager = await createManager(t, { prefix })
  await manager.subscribe()

  const addedEntries: CacheEntry[] = []
  manager.on('add-entry', entry => {
    if (entry.keyPrefix === prefix) {
      addedEntries.push(entry)
    }
  })

  const deletedEntries: CacheEntry[] = []
  manager.on('delete-entry', entry => {
    if (entry.keyPrefix === prefix) {
      deletedEntries.push(entry)
    }
  })

  const store = await createStore(t, { prefix, cacheTagsHeader: 'cache-tag' })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
    await manager.close()
  })

  strictEqual(requestsToOrigin, 0)

  {
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
  }

  // Wait for cache to expire
  await sleep(6000)

  strictEqual(addedEntries.length, 1)
  strictEqual(deletedEntries.length, 1)

  const addedEntry = addedEntries[0]
  ok(addedEntry.id)

  const deletedEntry = deletedEntries[0]
  ok(deletedEntry.id)
  strictEqual(deletedEntry.keyPrefix, prefix)

  strictEqual(deletedEntry.id, addedEntry.id)
})

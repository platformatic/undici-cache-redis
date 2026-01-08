import { ok, strictEqual } from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, interceptors } from 'undici'
import type { AddedCacheEntry } from '../../src/v2/types.ts'
import {
  createStore,
  createTags,
  createTagsHeader,
  getPrefixedKeys,
  getStorageKeys,
  gzip,
  listTags,
  preparePrefix,
  setVersion,
  ungzip,
  waitForCleanup,
  waitForEvents
} from '../helper.ts'

setVersion('2.0.0')

test('caches request successfully', async t => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  const emittedEntries: AddedCacheEntry[] = []
  store.on('entry:write', entry => {
    emittedEntries.push(entry)
  })

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

  strictEqual(emittedEntries.length, 1)
  const emittedEntry = emittedEntries[0]
  ok(emittedEntry.id)
  strictEqual(emittedEntry.value.statusCode, 200)
  ok(emittedEntry.value.headers)
  ok(emittedEntry.value.cachedAt)
  ok(emittedEntry.value.staleAt)
  ok(emittedEntry.value.deleteAt)
  strictEqual(emittedEntry.metadata.origin, origin)
  strictEqual(emittedEntry.metadata.method, 'GET')
  strictEqual(emittedEntry.metadata.path, '/')
  ok(emittedEntry.metadata.tags)
})

test('caches binary request successfully', async t => {
  let requestsToOrigin = 0

  const expectedResponse = 'hello'

  const server = createServer(async (_, res: ServerResponse) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')

    try {
      const gzippedResponse = await gzip(expectedResponse)
      res.end(gzippedResponse)
    } catch (err) {
      res.statusCode = 500
      res.end(err.message)
    }
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  const emittedEntries = []
  store.on('entry:write', entry => {
    emittedEntries.push(entry.entry)
  })

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

    const buffer = await body.arrayBuffer()
    const ungzippedBuffer = await ungzip(buffer)
    const response = ungzippedBuffer.toString()
    strictEqual(response, expectedResponse)
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

    const buffer = await body.arrayBuffer()
    const ungzippedBuffer = await ungzip(buffer)
    const response = ungzippedBuffer.toString()
    strictEqual(response, expectedResponse)

    strictEqual(headers.age, '1')
  }
})

test('invalidates response by cache tag', async t => {
  let requestsToOrigin = 0

  const cacheTag = randomBytes(8).toString('hex')
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
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

  await waitForCleanup(store, [{ prefix, type: 'tags', target: [cacheTag] }], async () => store.deleteTags([cacheTag]))

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

test('invalidates response by cache key', async t => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=2000')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
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

  await waitForCleanup(
    store,
    [{ prefix, type: 'key', target: getStorageKeys({ origin, method: 'GET', path: '/' }, prefix).request }],
    async () => store.deleteKeys([{ origin, method: 'GET', path: '/' }])
  )

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

test('invalidates other origin responses with the same cache tag / 2', async t => {
  let requestsToOrigin = 0

  const cacheTag = randomBytes(8).toString('hex')
  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=10')
    res.setHeader('cache-tag', cacheTag)
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
  })

  strictEqual(requestsToOrigin, 0)

  // Send initial request. This should reach the origin
  await waitForEvents(store, 'entry:write', 1, async () => {
    const response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')
  })

  await sleep(1000) // This is to set the age header correctly

  // Send second request that should be handled by cache
  {
    const response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')
    strictEqual(response.headers.age, '1')
  }

  // Send third request with different origin that should *not* be handled by cache
  await waitForEvents(store, 'entry:write', 1, async () => {
    const response = await client.request({
      origin: 'my-other-origin',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 2)
    strictEqual(await response.body.text(), 'asd')
  })

  await sleep(1000) // This is to set the age header correctly

  // Send fourth request that should be handled by cache
  {
    const response = await client.request({
      origin: 'my-other-origin',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 2)
    strictEqual(await response.body.text(), 'asd')
    strictEqual(response.headers.age, '1')
  }

  await store.deleteKeys([
    {
      origin: 'localhost',
      method: 'GET',
      path: '/'
    }
  ])

  // Send fifth request that should reach the origin again
  await waitForEvents(store, 'entry:write', 1, async () => {
    const response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 3)
    strictEqual(await response.body.text(), 'asd')
  })

  // Send sixth request with different origin that should *not* be handled by cache
  await waitForEvents(store, 'entry:write', 1, async () => {
    const response = await client.request({
      origin: 'my-other-origin',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 4)
    strictEqual(await response.body.text(), 'asd')
  })

  // Send seventh request with different origin that should be handled by cache
  {
    const response = await client.request({
      origin: 'my-other-origin',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 4)
    strictEqual(await response.body.text(), 'asd')
  }
})

test('invalidates GET cache by making POST to the same url', async t => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
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
      path: '/foo'
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
      path: '/foo'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    strictEqual(text, 'asd')
    strictEqual(headers.age, '1')
  }

  await waitForCleanup(
    store,
    {
      prefix,
      type: 'key',
      target: getStorageKeys({ origin, method: 'GET', path: '/foo' }, prefix).request
    },
    async () => {
      // Send POST request that should invalidate the cache
      const { statusCode, body } = await client.request({
        origin,
        method: 'POST',
        path: '/foo'
      })
      strictEqual(statusCode, 200)
      strictEqual(requestsToOrigin, 2)

      const text = await body.text()
      strictEqual(text, 'asd')
    }
  )

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Send third request that should reach the origin again
    const { statusCode, body } = await client.request({
      origin,
      method: 'GET',
      path: '/foo'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 3)

    const text = await body.text()
    strictEqual(text, 'asd')
  })
})

test('should not invalidate GET cache by making POST to the _different_ url', async t => {
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')
    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
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
      path: '/foo'
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
      path: '/foo'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 1)

    const text = await body.text()
    strictEqual(text, 'asd')
    strictEqual(headers.age, '1')
  }

  // Send POST request that should NOT invalidate the cache
  const { statusCode, body } = await client.request({
    origin,
    method: 'POST',
    path: '/bar'
  })
  strictEqual(statusCode, 200)
  strictEqual(requestsToOrigin, 2)

  const text = await body.text()
  strictEqual(text, 'asd')

  // Send third request that should NOT reach the origin again
  {
    const { statusCode, body } = await client.request({
      origin,
      method: 'GET',
      path: '/foo'
    })
    strictEqual(statusCode, 200)
    strictEqual(requestsToOrigin, 2)

    const text = await body.text()
    strictEqual(text, 'asd')
  }

  strictEqual(requestsToOrigin, 2)
})

test('should prioritize cached responses with different vary headers', async t => {
  const tags = createTags(2)
  let requestsToOrigin = 0

  const server = createServer((req, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')

    if (req.headers['response-vary-header']) {
      res.setHeader('vary', req.headers['response-vary-header'])
      res.setHeader('cache-tag', req.headers['cache-tag']!)
    }

    res.end(requestsToOrigin.toString())
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
  })

  strictEqual(requestsToOrigin, 0)

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Should hit the origin
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'cache-tag': createTagsHeader(tags, 1),
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'foo',
        'response-vary-header': 'test-header-1, test-header-2, test-header-3'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2, test-header-3')

    const text = await body.text()
    strictEqual(text, '1')
  })

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Should hit the origin (different vary headers)
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'cache-tag': createTagsHeader(tags, 2),
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'bar',
        'response-vary-header': 'test-header-1, test-header-2'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2')

    const text = await body.text()
    strictEqual(text, '2')
  })

  {
    // Should hit the first (more specific) cached response
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'foo'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2, test-header-3')

    const text = await body.text()
    strictEqual(text, '1')
  }

  // Invalidate the first cached response
  await waitForCleanup(store, [{ prefix, type: 'tags', target: listTags(tags, 1) }], () =>
    store.deleteTags(listTags(tags, 1)))

  {
    // Should hit the second
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'foo'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2')

    const text = await body.text()
    strictEqual(text, '2')
  }
})

test('should handle big number of concurrent requests', async t => {
  let requestsToOrigin = 0

  const server = createServer((req, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')

    if (req.headers['test-header']) {
      res.setHeader('vary', 'test-header')
    }

    res.end('asd')
  }).listen(0)

  await once(server, 'listening')

  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
  })

  strictEqual(requestsToOrigin, 0)

  const sendRequest = async (path: string, headers?: IncomingHttpHeaders) => {
    const { statusCode, body } = await client.request({
      method: 'GET',
      origin,
      path,
      headers
    })
    strictEqual(statusCode, 200)

    const text = await body.text()
    strictEqual(text, 'asd')
  }

  const promises: Promise<unknown>[] = []
  for (let i = 0; i < 20; i++) {
    promises.push(sendRequest('/test'))
    promises.push(sendRequest('/test', { 'test-header': 'foo' }))
  }

  await waitForEvents(store, 'entry:write', 2, () => Promise.all(promises))

  const keys = await getPrefixedKeys(prefix)

  const valuesKeys = keys.filter(key => key.includes('value|'))
  strictEqual(valuesKeys.length, 2)

  const bodiesKeys = keys.filter(key => key.includes('body|'))
  strictEqual(bodiesKeys.length, 2)
})

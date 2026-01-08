import { deepStrictEqual, equal, notEqual, strictEqual } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable, type Writable } from 'node:stream'
import { test } from 'node:test'
import { Client, interceptors } from 'undici'
import { type CacheValue, type CacheValueWithBody } from '../../src/index.ts'
import type { Cache } from '../../src/v2/cache.ts'
import { createStore, preparePrefix, setVersion, waitForEvents } from '../helper.ts'

setVersion('2.0.0')

function writeResponse (stream: Writable, body: (string | Buffer)[] = []) {
  for (const chunk of body) {
    stream.write(Buffer.from(chunk))
  }

  stream.end()
}

async function verifyResponse (response: CacheValueWithBody, requestValue: object, requestBody: unknown[]) {
  notEqual(response, undefined)
  notEqual(response.body, undefined)

  const stream = Readable.from(response.body ?? [])

  const body: string[] = []
  stream.on('data', chunk => {
    body.push(chunk.toString())
  })

  await once(stream, 'end')

  deepStrictEqual(
    { ...response, body },
    {
      ...requestValue,
      body: requestBody
    }
  )
}

test('should properly fill up and use the cache', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix, tracking: true })

  const request = {
    origin: 'localhost',
    path: '/',
    method: 'GET',
    headers: {}
  }
  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'bar' },
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }

  const requestBody = ['asd', '123']

  // Sanity check
  equal(await store.get(request), undefined)

  // Write the response to the store
  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    await once(writeStream, 'close')
  })

  // Now try fetching it with a deep copy of the original request
  let readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)

  await verifyResponse(readStream!, requestValue, requestBody)

  // Now let's write another request to the store
  const anotherRequest = {
    origin: 'localhost',
    path: '/asd',
    method: 'GET',
    headers: {}
  }
  const anotherValue = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'bar' },
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000
  }
  const anotherBody = ['asd2', '1234']

  // We haven't cached this one yet, make sure it doesn't confuse it with
  //  another request
  equal(await store.get(anotherRequest), undefined)

  // Now let's cache it
  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(anotherRequest, {
      ...anotherValue,
      body: []
    } as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, anotherBody)

    await once(writeStream, 'close')
  })

  readStream = await store.get(anotherRequest)
  notEqual(readStream, undefined)

  await verifyResponse(readStream!, anotherValue, anotherBody)

  // Let's disconnect the store to make sure we are not hitting the storage anymore
  await store.client.quit()

  // Let's get both the requests again.
  {
    // Now try fetching it with a deep copy of the original request
    const readStream1 = await store.get(structuredClone(request))
    notEqual(readStream1, undefined)
    await verifyResponse(readStream1!, requestValue, requestBody)

    const readStream2 = await store.get(anotherRequest)
    notEqual(readStream, undefined)
    await verifyResponse(readStream2!, anotherValue, anotherBody)
  }
})

test('should prioritize cached responses with different vary headers', async t => {
  const prefix = await preparePrefix(t)
  let requestsToOrigin = 0

  const server = createServer((req, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')

    if (req.headers['response-vary-header']) {
      res.setHeader('vary', req.headers['response-vary-header'])
    }

    res.end(requestsToOrigin.toString())
  }).listen(0)

  await once(server, 'listening')

  const store = await createStore(t, {
    prefix,
    tracking: true,
    cacheTagsHeader: 'cache-tag'
  })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
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

  strictEqual(requestsToOrigin, 2)

  // Now perform the  two calls again, they should not hit the origin but the storage and then fill up the tracking cache
  {
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

  {
    // Should hit the second
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'bar'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2')

    const text = await body.text()
    strictEqual(text, '2')
  }

  strictEqual(requestsToOrigin, 2)

  // Let's disconnect the store to make sure we are not hitting the storage anymore
  await store.client.quit()

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

  {
    // Should hit the second
    const { statusCode, headers, body } = await client.request({
      origin,
      method: 'GET',
      path: '/test',
      headers: {
        'test-header-1': 'foo',
        'test-header-2': 'foo',
        'test-header-3': 'bar'
      }
    })
    strictEqual(statusCode, 200)
    strictEqual(headers.vary, 'test-header-1, test-header-2')

    const text = await body.text()
    strictEqual(text, '2')
  }

  strictEqual(requestsToOrigin, 2)
})

test('should respect maxCount and maxSize parameter', async t => {
  const prefix = await preparePrefix(t)
  let requestsToOrigin = 0

  const server = createServer((req, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, s-maxage=20')

    res.end(
      req.headers['response-size']
        ? randomBytes(parseInt(req.headers['response-size'] as string)).toString('hex')
        : 'ok'
    )
  }).listen(0)

  await once(server, 'listening')

  const store = await createStore(t, {
    prefix,
    tracking: true,
    maxCount: 5,
    maxSize: 100
  })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  // Make sure maxCount is respected
  for (let i = 0; i < 10; i++) {
    // Hit the origin
    await waitForEvents(store, 'entry:write', 1, async () => {
      const { statusCode } = await client.request({
        origin,
        path: `/count/${i}`,
        method: 'GET'
      })

      strictEqual(statusCode, 200)
    })

    // Put into the storage and tracking cache
    {
      const { statusCode } = await client.request({
        origin,
        path: `/count/${i}`,
        method: 'GET'
      })

      strictEqual(statusCode, 200)
    }
  }

  strictEqual(requestsToOrigin, 10)

  strictEqual((store as Cache).tracking!.count, 5)
  strictEqual((store as Cache).tracking!.size, 10) // Each response is "ok" (2 bytes) - We only count bodies

  // Now add a single response of a hundred bytes to make sure maxSize is respected
  // Hit the origin
  await waitForEvents(store, 'entry:write', 1, async () => {
    const { statusCode } = await client.request({
      origin,
      path: '/large',
      method: 'GET',
      headers: {
        'response-size': '50'
      }
    })

    strictEqual(statusCode, 200)
  })

  // Put into the storage and tracking cache
  {
    const { statusCode } = await client.request({
      origin,
      path: '/large',
      method: 'GET'
    })

    strictEqual(statusCode, 200)
  }

  strictEqual(requestsToOrigin, 11)
  strictEqual((store as Cache).tracking!.count, 1) // At least the large one should be there
  strictEqual((store as Cache).tracking!.size, 100) // 50 random bytes represented as hex (100 bytes)

  // Finally, add another large response. Only this last one should remain
  // Hit the origin
  await waitForEvents(store, 'entry:write', 1, async () => {
    const { statusCode } = await client.request({
      origin,
      path: '/very-large',
      method: 'GET',
      headers: {
        'response-size': '150'
      }
    })

    strictEqual(statusCode, 200)
  })

  // Put into the storage and tracking cache
  {
    const { statusCode } = await client.request({
      origin,
      path: '/very-large',
      method: 'GET'
    })

    strictEqual(statusCode, 200)
  }

  strictEqual(requestsToOrigin, 12)
  strictEqual((store as Cache).tracking!.count, 1) // At least the large one should be there
  strictEqual((store as Cache).tracking!.size, 300) // 50 random bytes represented as hex (100 bytes)
})

test('should automatically delete entries when they expire', async t => {
  const prefix = await preparePrefix(t)
  let requestsToOrigin = 0

  const server = createServer((_, res) => {
    requestsToOrigin++
    res.setHeader('cache-control', 'public, max-age=1, s-maxage=1, stale-while-revalidate=1')
    res.end('ok')
  }).listen(0)

  await once(server, 'listening')

  const store = await createStore(t, {
    prefix,
    tracking: true,
    maxCount: 5,
    maxSize: 100
  })

  const origin = `http://localhost:${(server.address() as AddressInfo).port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await store.close()
    await client.close()
  })

  // Hit the origin
  await waitForEvents(store, 'entry:write', 1, async () => {
    const { statusCode } = await client.request({ origin, path: '/', method: 'GET' })
    strictEqual(statusCode, 200)
  })

  // Put into the storage and tracking cache
  {
    const { statusCode } = await client.request({ origin, path: '/', method: 'GET' })
    strictEqual(statusCode, 200)
  }

  strictEqual(requestsToOrigin, 1)
  strictEqual((store as Cache).tracking!.count, 1)
  strictEqual((store as Cache).tracking!.size, 2)

  // Wait for the entry to expire and be deleted
  await once(store as Cache, 'tracking:delete')

  strictEqual((store as Cache).tracking!.count, 0)
  strictEqual((store as Cache).tracking!.size, 0)
})

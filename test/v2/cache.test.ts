import { deepStrictEqual, equal, notEqual, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { Readable, type Writable } from 'node:stream'
import { test } from 'node:test'
import { type CacheValue, type CacheValueWithBody } from '../../src/index.ts'
import {
  createStore,
  createTags,
  createTagsHeader,
  getPrefixedKeys,
  getStorageKeys,
  listTags,
  preparePrefix,
  setVersion,
  waitForCleanup,
  waitForEvents
} from '../helper.ts'

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

test('matches interface', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  equal(typeof store.get, 'function')
  equal(typeof store.createWriteStream, 'function')
  equal(typeof store.delete, 'function')
})

// Checks that it can store & fetch different responses
test('basic functionality', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

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
})

test('returns stale response if possible', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

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
    cachedAt: Date.now() - 10000,
    staleAt: Date.now() - 1,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }
  const requestBody = ['part1', 'part2']

  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    await once(writeStream, 'close')
  })

  const readStream = await store.get(request)
  notEqual(readStream, undefined)
  await verifyResponse(readStream!, requestValue, requestBody)
})

test('a stale request is not overwritten', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const key = {
    origin: 'localhost',
    path: '/',
    method: 'GET',
    headers: {}
  }

  const value = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'bar' },
    cacheControlDirectives: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 1000,
    // deleteAt is different because stale-while-revalidate, stale-if-error, ...
    deleteAt: Date.now() + 5000
  }

  const body = [Buffer.from('asd'), Buffer.from('123')]

  // Sanity check
  equal(await store.get(key), undefined)

  await waitForEvents(store, 'entry:write', 1, async () => {
    const writable = store.createWriteStream(key, value as unknown as CacheValue)!
    notEqual(writable, undefined)
    writeResponse(writable, body)

    await once(writable, 'close')
  })

  {
    const result = await store.get(structuredClone(key))
    notEqual(result, undefined)
    deepStrictEqual(result, { ...value, body })
  }

  const value2 = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'baz' },
    cacheControlDirectives: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 1000,
    // deleteAt is different because stale-while-revalidate, stale-if-error, ...
    deleteAt: Date.now() + 5000
  }

  const body2 = [Buffer.from('foo'), Buffer.from('123')]

  const writable = store.createWriteStream(key, value2 as unknown as CacheValue)!
  notEqual(writable, undefined)
  writeResponse(writable, body2)

  await once(writable, 'close')

  {
    const result = await store.get(structuredClone(key))
    notEqual(result, undefined)
    deepStrictEqual(result, { ...value, body })
  }
})

test("doesn't return response past deletedAt", async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    origin: 'localhost',
    path: '/',
    method: 'GET',
    headers: {}
  }
  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    cachedAt: Date.now() - 20000,
    staleAt: Date.now() - 10000,
    deleteAt: Date.now() - 5000,
    headers: {},
    cacheControlDirectives: {}
  }
  const requestBody = ['part1', 'part2']

  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    await once(writeStream, 'close')
  })

  equal(await store.get(request), undefined)
})

test('respects vary directives', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    origin: 'localhost',
    path: '/',
    method: 'GET',
    headers: {
      'some-header': 'hello world'
    }
  }
  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'bar' },
    vary: {
      'some-header': 'hello world'
    },
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }
  const requestBody = ['part1', 'part2']

  // Sanity check
  equal(await store.get(request), undefined)

  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    await once(writeStream, 'close')
  })

  const readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)
  await verifyResponse(readStream!, requestValue, requestBody)

  const nonMatchingRequest = {
    origin: 'localhost',
    path: '/',
    method: 'GET',
    headers: {
      'some-header': 'another-value'
    }
  }
  equal(await store.get(nonMatchingRequest), undefined)
})

test('respects empty vary directives', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    origin: 'localhost',
    path: '/',
    method: 'GET'
  }

  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    headers: { foo: 'bar' },
    vary: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }
  const requestBody = ['part1', 'part2']

  // Sanity check
  equal(await store.get(request), undefined)

  await waitForEvents(store, 'entry:write', 1, async () => {
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    await once(writeStream, 'close')
  })

  const readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)
  await verifyResponse(readStream!, requestValue, requestBody)
})

test('returns cached values', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    origin: 'http://test-origin-1',
    path: '/foo?bar=baz',
    method: 'GET',
    headers: {}
  }
  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    headers: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
  })
})

test('invalidates cache by cache keys', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    origin: 'http://test-origin-1',
    path: '/foo?bar=baz',
    method: 'GET',
    headers: {}
  }
  const requestValue = {
    statusCode: 200,
    statusMessage: '',
    headers: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }

  await waitForEvents(store, 'entry:write', 1, async () => {
    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
  })

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 6)
  }

  const cacheKey = { origin: 'http://test-origin-1', path: '/foo?bar=baz', method: 'GET' }
  const storageKeys = getStorageKeys(cacheKey, prefix)

  await waitForCleanup(store, { prefix, type: 'key', target: storageKeys.request }, () => store.deleteKeys([cacheKey]))

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 0)
  }
})

test('invalidates cache by combined cache tag', async t => {
  const tags = createTags(3)
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-1?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-2?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2, 3)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2, 3)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-3?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 3)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 3)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 20)
  }

  await waitForCleanup(
    store,
    [
      { prefix, type: 'tags', target: listTags(tags, 1, 2) },
      {
        prefix,
        type: 'key',
        target: [
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-1?bar=baz',
              method: 'GET'
            },
            prefix
          ).request,
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-2?bar=baz',
              method: 'GET'
            },
            prefix
          ).request,
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-3?bar=baz',
              method: 'GET'
            },
            prefix
          ).request
        ]
      }
    ],
    () => store.deleteTags(listTags(tags, 1, 2))
  )

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 0)
  }
})

test('invalidates cache by cache tag', async t => {
  const tags = createTags(4)
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { cacheTagsHeader: 'cache-tag', prefix })

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-1?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 2)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-2?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 3)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 1, 3)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const request = {
      origin: 'http://test-origin-1',
      path: '/foo-3?bar=baz',
      method: 'GET',
      headers: {
        'cache-tag': createTagsHeader(tags, 3, 4)
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: {
        'cache-tag': createTagsHeader(tags, 3, 4)
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    }

    await waitForEvents(store, 'entry:write', 1, async () => {
      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    })
  }

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 21)
  }

  await waitForCleanup(
    store,
    [
      { prefix, type: 'tags', target: listTags(tags, 1, 4) },
      {
        prefix,
        type: 'key',
        target: [
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-1?bar=baz',
              method: 'GET'
            },
            prefix
          ).request,
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-2?bar=baz',
              method: 'GET'
            },
            prefix
          ).request,
          getStorageKeys(
            {
              origin: 'http://test-origin-1',
              path: '/foo-3?bar=baz',
              method: 'GET'
            },
            prefix
          ).request
        ]
      }
    ],
    () => store.deleteTags(listTags(tags, 1, 4))
  )

  {
    const keys = await getPrefixedKeys(prefix)
    strictEqual(keys.length, 0)
  }
})

test('saves entry with a custom id', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  const request = {
    id: 'custom-id',
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

  const writePromise = once(store, 'entry:write')
  await waitForEvents(store, 'entry:write', 1, async () => {
    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValue)!
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)
  })

  const [entry] = await writePromise
  strictEqual(entry.id, 'custom-id')
})

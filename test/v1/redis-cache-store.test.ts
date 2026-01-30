import { deepStrictEqual, equal, fail, notEqual, ok, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { Readable, type Writable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CacheValueWithBody } from '../../src/types.ts'
import {
  createStore,
  createTags,
  createTagsHeader,
  getPrefixedKeys,
  listTags,
  preparePrefix,
  setVersion
} from '../helper.ts'

setVersion('1.0.0')

test('matches interface', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  t.after(async () => {
    await store.close()
  })

  equal(typeof store.get, 'function')
  equal(typeof store.createWriteStream, 'function')
  equal(typeof store.delete, 'function')
})

// Checks that it can store & fetch different responses
test('basic functionality', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Sanity check
  equal(await store.get(request), undefined)

  // Write the response to the store
  let writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  await once(writeStream, 'close')

  // Now try fetching it with a deep copy of the original request
  let readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)

  deepStrictEqual(await readResponse(readStream!), {
    ...requestValue,
    body: requestBody
  })

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
  writeStream = store.createWriteStream(anotherRequest, {
    ...anotherValue,
    body: []
  } as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, anotherBody)

  await once(writeStream, 'close')

  readStream = await store.get(anotherRequest)
  notEqual(readStream, undefined)
  deepStrictEqual(await readResponse(readStream!), {
    ...anotherValue,
    body: anotherBody
  })
})

test('returns stale response if possible', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  await once(writeStream, 'close')
  await sleep(500)

  const readStream = await store.get(request)
  notEqual(readStream, undefined)
  deepStrictEqual(await readResponse(readStream!), {
    ...requestValue,
    body: requestBody
  })
})

test('a stale request is not overwritten', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, { prefix })

  t.after(async () => {
    await store.close()
  })

  // Sanity check
  equal(await store.get(key), undefined)

  {
    const writable = store.createWriteStream(key, value as unknown as CacheValueWithBody)!
    notEqual(writable, undefined)
    writeResponse(writable, body)
  }

  await sleep(1500)

  {
    const result = await store.get(structuredClone(key))
    notEqual(result, undefined)
    deepStrictEqual(result, {
      ...value,
      body
    })
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

  {
    const writable = store.createWriteStream(key, value2 as unknown as CacheValueWithBody)!
    notEqual(writable, undefined)
    writeResponse(writable, body2)
  }

  {
    const result = await store.get(structuredClone(key))
    notEqual(result, undefined)
    deepStrictEqual(result, {
      ...value,
      body
    })
  }
})

test("doesn't return response past deletedAt", async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  await once(writeStream, 'close')

  equal(await store.get(request), undefined)
})

test('respects vary directives', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Sanity check
  equal(await store.get(request), undefined)

  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  await once(writeStream, 'close')

  const readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)
  deepStrictEqual(await readResponse(readStream!), {
    ...requestValue,
    body: requestBody
  })

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Sanity check
  equal(await store.get(request), undefined)

  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  await once(writeStream, 'close')

  const readStream = await store.get(structuredClone(request))
  notEqual(readStream, undefined)
  deepStrictEqual(await readResponse(readStream!), {
    ...requestValue,
    body: requestBody
  })
})

test('returns cached values', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Write the response to the store
  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  writeResponse(writeStream)

  // Wait for redis to be written too
  await once(writeStream, 'close')
})

test('invalidates cache by cache keys', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Write the response to the store
  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  writeResponse(writeStream)

  // Wait for redis to be written too
  await once(writeStream, 'close')
  await sleep(500)

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 3)
  }

  await store.deleteKeys([{ method: 'GET', origin: 'http://test-origin-1', path: '/foo?bar=baz' }])

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 0)
  }
})

test('invalidates cache by combined cache tag', async t => {
  const tags = createTags(3)
  const prefix = await preparePrefix(t)

  const store = await createStore(t, {
    cacheTagsHeader: 'cache-tag',
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
  }

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 12)
  }

  await store.deleteTags([listTags(tags, 1, 2)])

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 4)

    const tagsKeys = keys.filter(key => key.includes('cache-tags'))
    strictEqual(tagsKeys.length, 1)

    ok(tagsKeys[0].includes(listTags(tags, 1, 3).sort().join(':')))
  }
})

test('invalidates cache by cache tag', async t => {
  const tags = createTags(4)
  const prefix = await preparePrefix(t)

  const store = await createStore(t, {
    cacheTagsHeader: 'cache-tag',
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
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

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
  }

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 12)
  }

  await store.deleteTags(listTags(tags, 1, 4).sort())

  {
    const keys = await getPrefixedKeys(prefix, {}, '')
    strictEqual(keys.length, 0)
  }
})

test('saves entry with a custom id', async t => {
  const prefix = await preparePrefix(t)

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

  const store = await createStore(t, {
    prefix,
    errorCallback: (err: Error) => {
      fail(err)
    }
  })

  t.after(async () => {
    await store.close()
  })

  // Sanity check
  equal(await store.get(request), undefined)

  // Write the response to the store
  const writeStream = store.createWriteStream(request, requestValue as unknown as CacheValueWithBody)!
  notEqual(writeStream, undefined)
  writeResponse(writeStream, requestBody)

  const [entry] = await once(store, 'write')
  strictEqual(entry.id, 'custom-id')
})

function writeResponse (stream: Writable, body: (string | Buffer)[] = []) {
  for (const chunk of body) {
    stream.write(Buffer.from(chunk))
  }

  stream.end()
}

async function readResponse ({ body: src, ...response }: CacheValueWithBody) {
  notEqual(response, undefined)
  notEqual(src, undefined)

  const stream = Readable.from(src ?? [])

  const body: string[] = []
  stream.on('data', chunk => {
    body.push(chunk.toString())
  })

  await once(stream, 'end')

  return {
    ...response,
    body
  }
}

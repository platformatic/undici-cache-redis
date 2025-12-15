// prettier-ignore-file

/*
  This test works as a compliance and integration suite for cache stores.
  It was adapted from v1 with minimal changes.
  Do not translate into Typescript and do not remove it.
*/

import { Redis } from 'iovalkey'
import { deepStrictEqual, equal, fail, notEqual, ok, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStore as _createStore } from '../src/index.ts'

const redisOptions = { port: 7001 }

describe('1.0.0', () => {
  cacheStoreTests('1.0.0')
})

describe('2.0.0', () => {
  cacheStoreTests('2.0.0')
})

function cacheStoreTests (version) {
  function createStore (opts) {
    opts ??= {}
    opts.clientOpts ??= {}

    Object.assign(opts.clientOpts, redisOptions)
    return _createStore(opts, version)
  }

  const readResponse = _readResponse.bind(null, version)

  describe('integration', () => {
    test('matches interface', async (t) => {
      const store = createStore()

      t.after(async () => {
        await store.close()
      })

      equal(typeof store.get, 'function')
      equal(typeof store.createWriteStream, 'function')
      equal(typeof store.delete, 'function')
    })

    // Checks that it can store & fetch different responses
    test('basic functionality', async (t) => {
      await cleanValkey()

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
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['asd', '123']

      /**
       * @type {import('../lib/internal-types.d.ts').CacheStore}
       */
      const store = createStore({
        clientOpts: {
          keyPrefix: `${crypto.randomUUID()}:`
        },
        errorCallback: (err) => {
          fail(err)
        }
      })

      t.after(async () => {
        await store.close()
      })

      // Sanity check
      equal(await store.get(request), undefined)

      // Write the response to the store
      let writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody)

      await once(writeStream, 'close')

      // Now try fetching it with a deep copy of the original request
      let readStream = await store.get(structuredClone(request))
      notEqual(readStream, undefined)

      deepStrictEqual(await readResponse(readStream), {
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
      })
      notEqual(writeStream, undefined)
      writeResponse(writeStream, anotherBody)

      await once(writeStream, 'close')

      readStream = await store.get(anotherRequest)
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...anotherValue,
        body: anotherBody,
      })
    })

    test('returns stale response if possible', async (t) => {
      await cleanValkey()

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
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['part1', 'part2']

      /**
       * @type {import('../lib/internal-types.d.ts').CacheStore}
       */
      const store = createStore({
        clientOpts: {
          keyPrefix: `${crypto.randomUUID()}:`
        },
        errorCallback: (err) => {
          fail(err)
        }
      })

      t.after(async () => {
        await store.close()
      })

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody)

      await once(writeStream, 'close')

      const readStream = await store.get(request)
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
      })
    })

    test('a stale request is overwritten', async (t) => {
      await cleanValkey()

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheKey}
       */
      const key = {
        origin: 'localhost',
        path: '/',
        method: 'GET',
        headers: {}
      }

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheValue}
       */
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

      const store = createStore()

      t.after(async () => {
        await store.close()
      })

      // Sanity check
      equal(await store.get(key), undefined)

      {
        const writable = store.createWriteStream(key, value)
        notEqual(writable, undefined)
        writeResponse(writable, body)
      }

      await sleep(1500)

      {
        const result = await store.get(structuredClone(key))
        notEqual(result, undefined)
        deepStrictEqual(omitV2Props(result, version), {
          ...value,
          body
        })
      }

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheValue}
       */
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
        const writable = store.createWriteStream(key, value2)
        notEqual(writable, undefined)
        writeResponse(writable, body2)
      }

      {
        const result = await store.get(structuredClone(key))
        notEqual(result, undefined)
        deepStrictEqual(omitV2Props(result, version), {
          ...value,
          body
        })
      }
    })

    test("doesn't return response past deletedAt", async (t) => {
      await cleanValkey()

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
        deleteAt: Date.now() - 5000
      }
      const requestBody = ['part1', 'part2']

      /**
       * @type {import('../lib/internal-types.d.ts').CacheStore}
       */
      const store = createStore({
        clientOpts: {
          keyPrefix: `${crypto.randomUUID()}:`
        },
        errorCallback: (err) => {
          fail(err)
        }
      })

      t.after(async () => {
        await store.close()
      })

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody)

      await once(writeStream, 'close')

      equal(await store.get(request), undefined)
    })

    test('respects vary directives', async (t) => {
      await cleanValkey()

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
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['part1', 'part2']

      /**
       * @type {import('../lib/internal-types.d.ts').CacheStore}
       */
      const store = createStore({
        clientOpts: {
          keyPrefix: `${crypto.randomUUID()}:`
        },
        errorCallback: (err) => {
          fail(err)
        }
      })

      t.after(async () => {
        await store.close()
      })

      // Sanity check
      equal(await store.get(request), undefined)

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody)

      await once(writeStream, 'close')

      const readStream = await store.get(structuredClone(request))
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
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

    test('respects empty vary directives', async (t) => {
      await cleanValkey()

      const request = {
        origin: 'localhost',
        path: '/',
        method: 'GET'
      }

      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: { foo: 'bar' },
        vary: {
          'header-1': null
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['part1', 'part2']

      /**
       * @type {import('../lib/internal-types.d.ts').CacheStore}
       */
      const store = createStore({
        clientOpts: {
          keyPrefix: `${crypto.randomUUID()}:`
        },
        errorCallback: (err) => {
          fail(err)
        }
      })

      t.after(async () => {
        await store.close()
      })

      // Sanity check
      equal(await store.get(request), undefined)

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody)

      await once(writeStream, 'close')

      const readStream = await store.get(structuredClone(request))
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
      })
    })
  })

  test('returns cached values', async (t) => {
    await cleanValkey()

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
      deleteAt: Date.now() + 20000
    }

    const store = createStore({
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
    })

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')
  })

  test('invalidates cache by cache keys', async (t) => {
    await cleanValkey()

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
      deleteAt: Date.now() + 20000
    }

    const store = createStore({
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
    })

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 3 : 6)
    }

    await store.deleteKeys([{ method: 'GET', origin: 'http://test-origin-1', path: '/foo?bar=baz' }])

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 0 : 2)
    }
  })

  test('invalidates cache by ids', async (t) => {
    await cleanValkey()

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
      deleteAt: Date.now() + 20000
    }

    const store = createStore({
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
    })

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream)

    // Wait for redis to be written too
    await once(writeStream, 'close')

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 3 : 6)
    }

    await store.deleteKeys([{ method: 'GET', origin: 'http://test-origin-1', path: '/foo?bar=baz' }])

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 0 : 2)
    }
  })

  test('invalidates cache by combined cache tag', async (t) => {
    await cleanValkey()

    const store = createStore({
      cacheTagsHeader: 'cache-tag',
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
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
          'cache-tag': 'tag1,tag2'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag1,tag2'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
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
          'cache-tag': 'tag1,tag2,tag3'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag1,tag2,tag3'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
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
          'cache-tag': 'tag1,tag3'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag1,tag3'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    }

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 12 : 20)
    }

    await store.deleteTags([['tag1', 'tag2']])

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 4 : 11)

      if (version === '1.0.0') {
        const tagsKeys = keys.filter(key => key.includes('cache-tags'))
        strictEqual(tagsKeys.length, 1)

        ok(tagsKeys[0].includes('tag1:tag3'))
      }
    }
  })

  test('invalidates cache by cache tag', async (t) => {
    await cleanValkey()

    const store = createStore({
      cacheTagsHeader: 'cache-tag',
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
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
          'cache-tag': 'tag1,tag2'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag1,tag2'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
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
          'cache-tag': 'tag1,tag3'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag1,tag3'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
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
          'cache-tag': 'tag3,tag4'
        }
      }
      const requestValue = {
        statusCode: 200,
        statusMessage: '',
        headers: {
          'cache-tag': 'tag3,tag4'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }

      // Write the response to the store
      const writeStream = store.createWriteStream(request, requestValue)
      writeResponse(writeStream)

      // Wait for redis to be written too
      await once(writeStream, 'close')
    }

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 12 : 21)
    }

    await store.deleteTags(['tag1', 'tag4'])

    {
      const keys = await getAllKeys()
      strictEqual(keys.length, version === '1.0.0' ? 0 : 5)
    }
  })

  test('saves entry with a custom id', async (t) => {
    await cleanValkey()

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
      deleteAt: Date.now() + 20000
    }
    const requestBody = ['asd', '123']

    /**
     * @type {import('../lib/internal-types.d.ts').CacheStore}
     */
    const store = createStore({
      clientOpts: {
        keyPrefix: `${crypto.randomUUID()}:`
      },
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
    })

    // Sanity check
    equal(await store.get(request), undefined)

    const writePromise = once(store, version === '1.0.0' ? 'write' : 'entry:write')

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    const [entry] = await writePromise
    strictEqual(entry.id, 'custom-id')
  })
}

/**
 * @param {import('node:stream').Writable} stream
 * @param {string[]} body
 */
function writeResponse (stream, body = []) {
  for (const chunk of body) {
    stream.write(Buffer.from(chunk))
  }

  stream.end()
}

/**
 * @param {import('../lib/internal-types.d.ts').GetResult} result
 * @returns {Promise<import('../lib/internal-types.d.ts').GetResult | { body: Buffer[] }>}
 */
async function _readResponse (version, { body: src, ...response }) {
  notEqual(response, undefined)
  notEqual(src, undefined)

  const stream = Readable.from(src ?? [])

  /**
   * @type {Buffer[]}
   */
  const body = []
  stream.on('data', chunk => {
    body.push(chunk.toString())
  })

  await once(stream, 'end')

  return {
    ...omitV2Props(response, version),
    body
  }
}

function omitV2Props (obj, version) {
  if (version === '2.0.0') {
    // Ignore additional v2 properties
    for (const prop of ['cacheTags', 'id', 'keyPrefix', 'method', 'origin', 'path']) {
      delete obj[prop]
    }
  }

  return obj
}

async function cleanValkey () {
  const redis = new Redis(redisOptions)
  await redis.flushdb()
  redis.quit()
}

async function getAllKeys () {
  const redis = new Redis(redisOptions)
  const keys = await redis.keys('*')
  redis.quit()

  return keys
}

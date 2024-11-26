// @ts-check
'use strict'

const { describe, test } = require('node:test')
const { deepStrictEqual, notEqual, equal, fail } = require('node:assert')
const { Readable } = require('node:stream')
const { once } = require('node:events')
const RedisCacheStore = require('../lib/redis-cache-store')

cacheStoreTests(RedisCacheStore)

function cacheStoreTests (CacheStore) {
  describe(CacheStore.prototype.constructor.name, () => {
    test('matches interface', async (t) => {
      const store = new CacheStore()

      t.after(async () => {
        await store.close()
      })

      equal(typeof store.get, 'function')
      equal(typeof store.createWriteStream, 'function')
      equal(typeof store.delete, 'function')
    })

    // Checks that it can store & fetch different responses
    test('basic functionality', async (t) => {
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
      const store = new CacheStore({
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
      const store = new CacheStore({
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

    test('doesn\'t return response past deletedAt', async (t) => {
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
      const store = new CacheStore({
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
      const store = new CacheStore({
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
  })

  test('returns cached values', async (t) => {
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

    const store = new CacheStore({
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

    const cachedRoutes = await store.getRoutes()
    deepStrictEqual(cachedRoutes, [
      { method: 'GET', url: 'http://test-origin-1/foo?bar=baz' }
    ])
  })

  test('invalidates routes', async (t) => {
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

    const store = new CacheStore({
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
      const cachedRoutes = await store.getRoutes()
      deepStrictEqual(cachedRoutes, [
        { method: 'GET', url: 'http://test-origin-1/foo?bar=baz' }
      ])
    }

    await store.deleteRoutes([
      { method: 'GET', url: 'http://test-origin-1/foo?bar=baz' }
    ])

    {
      const cachedRoutes = await store.getRoutes()
      deepStrictEqual(cachedRoutes, [])
    }
  })

  test('invalidates routes by cache tag', async (t) => {
    const store = new CacheStore({
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
      const cachedRoutes = await store.getRoutes()
      deepStrictEqual(cachedRoutes.sort(sortRoutes), [
        { method: 'GET', url: 'http://test-origin-1/foo-1?bar=baz' },
        { method: 'GET', url: 'http://test-origin-1/foo-2?bar=baz' },
        { method: 'GET', url: 'http://test-origin-1/foo-3?bar=baz' }
      ])
    }

    await store.deleteByCacheTags('http://test-origin-1', ['tag1'])

    {
      const cachedRoutes = await store.getRoutes()
      deepStrictEqual(cachedRoutes, [
        { method: 'GET', url: 'http://test-origin-1/foo-3?bar=baz' }
      ])
    }
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
async function readResponse ({ body: src, ...response }) {
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
    ...response,
    body
  }
}

function sortRoutes (r1, r2) {
  return r1.url.localeCompare(r2.url)
}

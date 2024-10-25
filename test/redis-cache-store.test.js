'use strict'

const { describe, test } = require('node:test')
const { deepStrictEqual, notEqual, equal, fail } = require('node:assert')
const { once } = require('node:events')
const RedisCacheStore = require('../lib/redis-cache-store')

cacheStoreTests(RedisCacheStore)

const setTimeoutAsync = (time) => new Promise((resolve) => setTimeout(resolve, time))

function cacheStoreTests (CacheStore) {
  describe(CacheStore.prototype.constructor.name, () => {
    test('matches interface', async (t) => {
      const store = new CacheStore()

      t.after(async () => {
        await setTimeoutAsync(100)
        await store.close()
      })

      equal(typeof store.isFull, 'boolean')
      equal(typeof store.createReadStream, 'function')
      equal(typeof store.createWriteStream, 'function')
      equal(typeof store.deleteByOrigin, 'function')
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
        rawHeaders: [Buffer.from('1'), Buffer.from('2'), Buffer.from('3')],
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['asd', '123']
      const requestTrailers = ['a', 'b', 'c']

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheStore}
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

      await store.deleteByOrigin('localhost')

      // Sanity check
      equal(await store.createReadStream(request), undefined)

      // Write the response to the store
      let writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody, requestTrailers)

      // Wait for redis to be written too
      await setTimeoutAsync(500)

      // Now try fetching it with a deep copy of the original request
      let readStream = await store.createReadStream(structuredClone(request))
      notEqual(readStream, undefined)

      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
        rawTrailers: requestTrailers
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
        rawHeaders: [Buffer.from('1'), Buffer.from('2'), Buffer.from('3')],
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }
      const anotherBody = ['asd2', '1234']
      const anotherTrailers = ['d', 'e', 'f']

      // We haven't cached this one yet, make sure it doesn't confuse it with
      //  another request
      equal(await store.createReadStream(anotherRequest), undefined)

      // Now let's cache it
      writeStream = store.createWriteStream(anotherRequest, {
        ...anotherValue,
        body: []
      })
      notEqual(writeStream, undefined)
      writeResponse(writeStream, anotherBody, anotherTrailers)

      // Wait for redis to be written too
      await setTimeoutAsync(500)

      readStream = await store.createReadStream(anotherRequest)
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...anotherValue,
        body: anotherBody,
        rawTrailers: anotherTrailers
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
        rawHeaders: [Buffer.from('1'), Buffer.from('2'), Buffer.from('3')],
        cachedAt: Date.now() - 10000,
        staleAt: Date.now() - 1,
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['part1', 'part2']
      const requestTrailers = [4, 5, 6]

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheStore}
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

      await store.deleteByOrigin('localhost')

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody, requestTrailers)

      // Wait for redis to be written too
      await setTimeoutAsync(500)

      const readStream = await store.createReadStream(request)
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
        rawTrailers: requestTrailers
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
      const rawTrailers = ['4', '5', '6']

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheStore}
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

      await store.deleteByOrigin('localhost')

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody, rawTrailers)

      // Wait for redis to be written too & for it to expire
      await setTimeoutAsync(500)

      equal(await store.createReadStream(request), undefined)
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
        rawHeaders: [Buffer.from('1'), Buffer.from('2'), Buffer.from('3')],
        vary: {
          'some-header': 'hello world'
        },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      }
      const requestBody = ['part1', 'part2']
      const requestTrailers = ['4', '5', '6']

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheStore}
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

      await store.deleteByOrigin('localhost')

      // Sanity check
      equal(await store.createReadStream(request), undefined)

      const writeStream = store.createWriteStream(request, requestValue)
      notEqual(writeStream, undefined)
      writeResponse(writeStream, requestBody, requestTrailers)

      // Wait for redis to be written too
      await setTimeoutAsync(500)

      const readStream = await store.createReadStream(structuredClone(request))
      notEqual(readStream, undefined)
      deepStrictEqual(await readResponse(readStream), {
        ...requestValue,
        body: requestBody,
        rawTrailers: requestTrailers
      })

      const nonMatchingRequest = {
        origin: 'localhost',
        path: '/',
        method: 'GET',
        headers: {
          'some-header': 'another-value'
        }
      }
      equal(await store.createReadStream(nonMatchingRequest), undefined)
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
      rawHeaders: [],
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

    await store.deleteByOrigin('http://test-origin-1')

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream, [], [])

    // Wait for redis to be written too
    await setTimeoutAsync(500)

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
      rawHeaders: [],
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

    await store.deleteByOrigin('http://test-origin-1')

    // Write the response to the store
    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream, [], [])

    // Wait for redis to be written too
    await setTimeoutAsync(500)

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
}

/**
 * @param {import('../../types/cache-interceptor.d.ts').default.CacheStoreWriteable} stream
 * @param {string[]} body
 * @param {string[]} trailers
 */
function writeResponse (stream, body, trailers) {
  for (const chunk of body) {
    stream.write(Buffer.from(chunk))
  }

  stream.rawTrailers = trailers
  stream.end()
}

/**
 * @param {import('../../types/cache-interceptor.d.ts').default.CacheStoreReadable} stream
 * @returns {Promise<import('../../types/cache-interceptor.d.ts').default.CacheStoreValue>}
 */
async function readResponse (stream) {
  const body = []
  stream.on('data', chunk => {
    body.push(chunk.toString())
  })

  await once(stream, 'end')

  return {
    ...stream.value,
    body
  }
}

// @ts-check
'use strict'

const { describe, test } = require('node:test')
const { strictEqual, deepStrictEqual, notEqual, equal, fail, ok } = require('node:assert')
const { Readable } = require('node:stream')
const { once } = require('node:events')
const { Redis } = require('iovalkey')
const RedisCacheStore = require('../lib/redis-cache-store')
const { getAllKeys, cleanValkey } = require('./helper.js')
const { setTimeout: sleep } = require('node:timers/promises')

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

    test('write stream fails when the write to redis fails', async (t) => {
      const reportedErrors = []
      const store = new CacheStore({
        clientOpts: { port: 1, retryStrategy: () => null, maxRetriesPerRequest: 0 },
        tracking: false,
        errorCallback: err => {
          reportedErrors.push(err)
        }
      })
      t.after(() => store.close())

      const writeStream = store.createWriteStream({
        origin: 'localhost',
        path: '/',
        method: 'GET',
        headers: {}
      }, {
        statusCode: 200,
        statusMessage: '',
        headers: {},
        cacheControlDirectives: {},
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      })

      writeStream.end(Buffer.from('body'))
      const [streamError] = await once(writeStream, 'error')

      deepStrictEqual(reportedErrors, [streamError])
      strictEqual(writeStream.destroyed, true)
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

    test('a stale request is overwritten', async (t) => {
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

      const store = new CacheStore()

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
        deepStrictEqual(result, {
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
        deepStrictEqual(result, {
          ...value,
          body
        })
      }
    })

    test('doesn\'t return response past deletedAt', async (t) => {
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
  })

  test('does not use SCAN or KEYS to look up, write or delete', async (t) => {
    await cleanValkey()

    const redis = new Redis()
    const store = new CacheStore({
      clientOpts: { keyPrefix: `${crypto.randomUUID()}:` },
      cacheTagsHeader: 'cache-tag',
      tracking: false,
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
      await redis.quit()
    })

    const scanCalls = async () => {
      const stats = await redis.info('commandstats')
      return [...stats.matchAll(/cmdstat_(scan|keys):calls=(\d+)/g)].reduce((sum, [, , calls]) => sum + Number(calls), 0)
    }
    const before = await scanCalls()

    const request = {
      origin: 'http://test-origin-1',
      path: '/foo?bar=baz',
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    }
    const requestValue = {
      statusCode: 200,
      statusMessage: '',
      headers: { 'cache-tag': 'foo' },
      vary: {
        accept: 'application/json'
      },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000
    }

    const writeStream = store.createWriteStream(request, requestValue)
    writeResponse(writeStream, ['indexed'])
    await once(writeStream, 'close')

    const readStream = await store.get(structuredClone(request))
    notEqual(readStream, undefined)
    deepStrictEqual(await readResponse(readStream), {
      ...requestValue,
      body: ['indexed']
    })

    await store.deleteKeys([request])
    await store.delete(request)
    await store.deleteTags(['foo'])

    strictEqual(await scanCalls(), before)
  })

  test('uses a provided client and does not close it', async (t) => {
    await cleanValkey()

    const redis = new Redis()
    const store = new CacheStore({
      client: redis,
      tracking: false,
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(() => redis.quit())

    const request = {
      origin: 'http://test-origin-1',
      path: '/',
      method: 'GET',
      headers: {}
    }

    const writeStream = store.createWriteStream(request, {
      statusCode: 200,
      statusMessage: '',
      headers: {},
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000
    })
    writeResponse(writeStream, ['body'])
    await once(writeStream, 'close')

    notEqual(await store.get(request), undefined)

    await store.close()
    strictEqual(redis.status, 'ready')
  })

  test('concurrent writes, deletes and purges', async (t) => {
    // A client whose `delayed` commands wait until open() is called, to force
    // an interleaving of concurrent operations
    const clients = []
    const gatedClient = (...delayed) => {
      const redis = new Redis()
      clients.push(redis)
      let open
      const gate = new Promise(resolve => { open = resolve })
      const client = new Proxy(redis, {
        get (target, prop) {
          const value = Reflect.get(target, prop)
          if (typeof value !== 'function') return value
          if (delayed.includes(prop)) return (...args) => gate.then(() => value.apply(target, args))
          return value.bind(target)
        }
      })
      return { client, open }
    }
    const createStore = (client = gatedClient().client) => new CacheStore({
      client,
      tracking: false,
      cacheTagsHeader: 'cache-tag',
      errorCallback: (err) => {
        fail(err)
      }
    })
    const write = async (store, { ttl = 60_000, tags = [], language, body = 'body' } = {}) => {
      const now = Date.now()
      const writeStream = store.createWriteStream(request(language), {
        statusCode: 200,
        statusMessage: '',
        headers: { 'cache-tag': tags.join(',') },
        vary: language ? { 'accept-language': language } : undefined,
        cachedAt: now,
        staleAt: now + ttl,
        deleteAt: now + ttl
      })
      writeResponse(writeStream, [body])
      await once(writeStream, 'close')
    }
    const request = (language) => ({
      origin: 'http://test-origin-1',
      path: '/',
      method: 'GET',
      headers: language ? { 'accept-language': language } : {}
    })
    const read = async (store, language) => {
      const result = await store.get(request(language))
      return result && (await readResponse(result)).body.join('')
    }
    const indexTtl = async () => {
      const redis = clients[0]
      return redis.pttl((await redis.keys('*index:*'))[0])
    }

    t.after(() => Promise.all(clients.map(client => client.quit())))

    await t.test('the index lives as long as the longest of two concurrent first writes', async () => {
      await cleanValkey()
      const short = gatedClient('set', 'hset', 'pexpireat')
      const long = gatedClient('set', 'hset', 'pexpireat')
      const writes = Promise.all([
        write(createStore(short.client), { ttl: 1000, language: 'en' }),
        write(createStore(long.client), { ttl: 60_000, language: 'pt' })
      ])
      await sleep(100)
      short.open()
      await sleep(100)
      long.open()
      await writes

      ok(await indexTtl() > 50_000)
    })

    await t.test('the index expires when it is deleted during a write', async () => {
      await cleanValkey()
      const store = createStore()
      await write(store, { body: 'old' })

      const writer = gatedClient('set', 'hset', 'pexpireat')
      const writing = write(createStore(writer.client), { body: 'new' })
      await sleep(100)
      await store.delete(request())
      writer.open()
      await writing

      ok(await indexTtl() > 0)
    })

    await t.test('a response cached again while a purge runs can still be purged', async () => {
      await cleanValkey()
      const store = createStore()
      await write(store, { tags: ['x'], body: 'v1' })

      const purger = gatedClient('srem')
      const purging = createStore(purger.client).deleteTags(['x'])
      await sleep(100)
      await write(store, { tags: ['x'], body: 'v2' })
      purger.open()
      await purging

      await store.deleteTags(['x'])
      strictEqual(await read(store), undefined)
    })

    await t.test('dropping an expired variant does not drop its concurrent rewrite', async () => {
      await cleanValkey()
      const store = createStore()
      await write(store, { language: 'de' })
      await write(store, { ttl: 200, tags: ['x'], language: 'en', body: 'en-v1' })
      await sleep(300)

      const writer = gatedClient('hdel', 'srem', 'del', 'eval')
      const writing = write(createStore(writer.client), { language: 'pt' })
      await sleep(100)
      await write(store, { tags: ['x'], language: 'en', body: 'en-v2' })
      writer.open()
      await writing

      strictEqual(await read(store, 'en'), 'en-v2')
      await store.deleteTags(['x'])
      strictEqual(await read(store, 'en'), undefined)
    })
  })

  test('container keys live as long as their longest entry', async (t) => {
    await cleanValkey()

    const keyPrefix = `${crypto.randomUUID()}:`
    const redis = new Redis()
    const store = new CacheStore({
      clientOpts: { keyPrefix },
      cacheTagsHeader: 'cache-tag',
      tracking: false,
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
      await redis.quit()
    })

    const now = Date.now()
    const write = async (encoding, ttl) => {
      const writeStream = store.createWriteStream({
        origin: 'http://test-origin-1',
        path: '/',
        method: 'GET',
        headers: { 'accept-encoding': encoding }
      }, {
        statusCode: 200,
        statusMessage: '',
        headers: { 'cache-tag': 'foo' },
        vary: { 'accept-encoding': encoding },
        cachedAt: now,
        staleAt: now + ttl,
        deleteAt: now + ttl
      })
      writeResponse(writeStream, ['body'])
      await once(writeStream, 'close')
    }

    await write('gzip', 60_000)
    await write('br', 10_000)

    const keys = await getAllKeys()
    const indexKey = keys.find(key => key.startsWith(`${keyPrefix}index:`))
    const tagIndexKey = keys.find(key => key.startsWith(`${keyPrefix}tag-index:`))

    for (const key of [indexKey, tagIndexKey]) {
      const ttl = await redis.pttl(key)
      ok(ttl > 50_000 && ttl <= 60_000, `${key} ttl ${ttl}`)
    }
  })

  test('removes expired variants from the index on write', async (t) => {
    await cleanValkey()

    const keyPrefix = `${crypto.randomUUID()}:`
    const redis = new Redis()
    const store = new CacheStore({
      clientOpts: { keyPrefix },
      tracking: false,
      errorCallback: (err) => {
        fail(err)
      }
    })

    t.after(async () => {
      await store.close()
      await redis.quit()
    })

    const write = async (encoding, ttl) => {
      const now = Date.now()
      const writeStream = store.createWriteStream({
        origin: 'http://test-origin-1',
        path: '/',
        method: 'GET',
        headers: { 'accept-encoding': encoding }
      }, {
        statusCode: 200,
        statusMessage: '',
        headers: {},
        vary: { 'accept-encoding': encoding },
        cachedAt: now,
        staleAt: now + ttl,
        deleteAt: now + ttl
      })
      writeResponse(writeStream, [encoding])
      await once(writeStream, 'close')
    }

    await write('gzip', 1000)
    await write('br', 10_000)

    const indexKey = (await getAllKeys()).find(key => key.startsWith(`${keyPrefix}index:`))
    strictEqual(await redis.hlen(indexKey), 2)

    await sleep(1100)
    strictEqual(await store.get({
      origin: 'http://test-origin-1',
      path: '/',
      method: 'GET',
      headers: { 'accept-encoding': 'gzip' }
    }), undefined)

    await write('deflate', 10_000)
    strictEqual(await redis.hlen(indexKey), 2)
  })

  test('deleteTags only deletes entries of its own key prefix', async (t) => {
    await cleanValkey()

    const stores = ['a:', 'b:'].map(keyPrefix => new CacheStore({
      clientOpts: { keyPrefix },
      cacheTagsHeader: 'cache-tag',
      tracking: false,
      errorCallback: (err) => {
        fail(err)
      }
    }))

    t.after(async () => {
      await Promise.all(stores.map(store => store.close()))
    })

    const request = {
      origin: 'http://test-origin-1',
      path: '/',
      method: 'GET',
      headers: {}
    }

    for (const store of stores) {
      const writeStream = store.createWriteStream(request, {
        statusCode: 200,
        statusMessage: '',
        headers: { 'cache-tag': 'shared' },
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      })
      writeResponse(writeStream, ['body'])
      await once(writeStream, 'close')
    }

    await stores[0].deleteTags(['shared'])

    strictEqual(await stores[0].get(request), undefined)
    notEqual(await stores[1].get(request), undefined)
  })

  test('tracking cache keeps working after connections are lost', async (t) => {
    await cleanValkey()

    const keyPrefix = `${crypto.randomUUID()}:`
    const redis = new Redis()
    const opts = {
      clientOpts: { keyPrefix },
      errorCallback: (err) => {
        fail(err)
      }
    }
    const reader = new CacheStore(opts)
    const writer = new CacheStore({ ...opts, tracking: false })

    t.after(async () => {
      await reader.close()
      await writer.close()
      await redis.quit()
    })

    const request = {
      origin: 'http://test-origin-1',
      path: '/',
      method: 'GET',
      headers: {}
    }

    const write = async (body) => {
      const writeStream = writer.createWriteStream(request, {
        statusCode: 200,
        statusMessage: '',
        headers: {},
        cachedAt: Date.now(),
        staleAt: Date.now() + 10000,
        deleteAt: Date.now() + 20000
      })
      writeResponse(writeStream, [body])
      await once(writeStream, 'close')
    }

    const readBody = async () => {
      const result = await reader.get(structuredClone(request))
      return result && (await readResponse(result)).body
    }

    await sleep(100)

    // Kill the tracked connection and the invalidation subscriber in turn
    for (const killed of ['tracked', 'subscriber']) {
      await write(`before ${killed}`)
      await sleep(100)
      deepStrictEqual(await readBody(), [`before ${killed}`])

      const clients = await redis.call('CLIENT', 'LIST')
      const line = clients.split('\n').find(line =>
        killed === 'tracked' ? line.includes('flags=t') : line.includes('cmd=subscribe')
      )
      ok(line, `no ${killed} connection found`)
      await redis.call('CLIENT', 'KILL', 'ID', line.match(/id=(\d+)/)[1])
      await sleep(500)

      // Tracking is enabled again, so a cached value is invalidated by a write
      ok((await redis.call('CLIENT', 'LIST')).includes('flags=t'))
      deepStrictEqual(await readBody(), [`before ${killed}`])
      await write(`after ${killed}`)
      await sleep(100)
      deepStrictEqual(await readBody(), [`after ${killed}`])
    }
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
      const keys = await getAllKeys()
      strictEqual(keys.length, 4)
    }

    await store.deleteKeys([
      { method: 'GET', origin: 'http://test-origin-1', path: '/foo?bar=baz' }
    ])

    {
      const keys = await getAllKeys()
      strictEqual(countEntryKeys(keys), 0)
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
      const keys = await getAllKeys()
      strictEqual(keys.length, 4)
    }

    await store.deleteKeys([
      { method: 'GET', origin: 'http://test-origin-1', path: '/foo?bar=baz' }
    ])

    {
      const keys = await getAllKeys()
      strictEqual(countEntryKeys(keys), 0)
    }
  })

  test('invalidates cache by combined cache tag', async (t) => {
    await cleanValkey()

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
      strictEqual(countEntryKeys(keys), 12)
    }

    await store.deleteTags([['tag1', 'tag2']])

    {
      const keys = await getAllKeys()
      strictEqual(countEntryKeys(keys), 4)

      const tagsKeys = keys.filter(key => key.includes('cache-tags'))
      strictEqual(tagsKeys.length, 1)

      ok(tagsKeys[0].includes('tag1:tag3'))
    }
  })

  test('invalidates cache by cache tag', async (t) => {
    await cleanValkey()

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
      const keys = await getAllKeys()
      strictEqual(countEntryKeys(keys), 12)
    }

    await store.deleteTags(['tag1', 'tag4'])

    {
      const keys = await getAllKeys()
      strictEqual(countEntryKeys(keys), 0)
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
    const writeStream = store.createWriteStream(request, requestValue)
    notEqual(writeStream, undefined)
    writeResponse(writeStream, requestBody)

    const [entry] = await once(store, 'write')
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

function countEntryKeys (keys) {
  return keys.filter(key =>
    key.includes('metadata:') ||
    key.includes('values:') ||
    key.includes('ids:') ||
    key.includes('cache-tags:')
  ).length
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

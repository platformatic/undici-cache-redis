import { deepStrictEqual, equal, notEqual, ok, throws } from 'node:assert'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Client, interceptors } from 'undici'
import DefaultCache, { createManager, createStore, RedisCache, RedisCacheManager, RedisCacheStore } from '../../index.js'
import TrackingCache from '../../src/v2/tracking-cache.js'
import {
  decodeBody,
  encodeBodyChunk,
  normalizePrefix,
  normalizePrefixes,
  serializeForHash,
  serializeHeaders,
  unique,
  validateHashTagPart,
  varyMatches
} from '../../src/v2/utils.js'
import { cleanValkey, getAllKeys } from '../helper.js'

function cacheValue (opts = {}) {
  return {
    statusCode: 200,
    statusMessage: '',
    headers: opts.headers ?? {},
    vary: opts.vary,
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }
}

async function write (store, key, value, body) {
  const stream = store.createWriteStream(key, value)
  stream.end(body)
  await once(stream, 'close')
}

test('v2 stores and reads variants without scan-backed metadata keys', async (t) => {
  await cleanValkey()

  const store = new RedisCache({
    prefix: `${crypto.randomUUID()}:`,
    tracking: false,
    cacheTagsHeader: 'cache-tag'
  })

  t.after(() => store.close())

  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/foo',
    headers: { language: 'en' }
  }

  const value = {
    statusCode: 200,
    statusMessage: '',
    headers: { 'cache-tag': 'tag1,tag2' },
    vary: { language: 'en' },
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }

  const writeStream = store.createWriteStream(key, value)
  writeStream.end('hello')
  await once(writeStream, 'close')

  const result = await store.get({ ...key })
  notEqual(result, undefined)
  deepStrictEqual(result.body, [Buffer.from('hello')])
  equal(result.vary.language, 'en')

  const miss = await store.get({ ...key, headers: { language: 'it' } })
  equal(miss, undefined)

  const entries = await store.entries({ origin: key.origin, method: key.method, path: key.path })
  equal(entries.length, 1)
  deepStrictEqual(entries[0].tags, ['tag1', 'tag2'])

  const keys = await getAllKeys()
  equal(keys.some(key => key.includes('metadata:')), false)
  equal(keys.some(key => key.includes('tag1')), false)
  equal(keys.some(key => key.includes('tag2')), false)
})

test('v2 is the default public API', async () => {
  equal(DefaultCache, RedisCache)
  const store = createStore({ tracking: false })
  equal(store.constructor, RedisCache)
  await store.close()
})

test('versioned factories can still create v1 classes', async () => {
  const store = createStore({ tracking: false }, '1.0.0')
  const storeAlias = createStore({ tracking: false }, '1')
  const manager = createManager({}, '1.0.0')
  const managerAlias = createManager({}, '1')
  const v2Manager = createManager({ tracking: false })

  try {
    equal(store.constructor, RedisCacheStore)
    equal(storeAlias.constructor, RedisCacheStore)
    equal(manager.constructor, RedisCacheManager)
    equal(managerAlias.constructor, RedisCacheManager)
    equal(v2Manager.constructor, RedisCache)
  } finally {
    await store.close()
    await storeAlias.close()
    await manager.close()
    await managerAlias.close()
    await v2Manager.close()
  }
})

test('v2 works with undici cache interceptor', async (t) => {
  await cleanValkey()

  let requests = 0
  const server = createServer((req, res) => {
    requests++
    res.setHeader('cache-control', 'public, s-maxage=60')
    res.setHeader('cache-tag', req.headers['cache-tag'] ?? 'default')
    if (req.headers.language) {
      res.setHeader('vary', 'language')
    }
    res.end(`${req.headers.language ?? 'none'}:${requests}`)
  }).listen(0)
  await once(server, 'listening')

  const store = createStore({ prefix: `${crypto.randomUUID()}:`, tracking: false, cacheTagsHeader: 'cache-tag' })
  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
    await store.close()
  })

  {
    const { body } = await client.request({ origin, method: 'GET', path: '/foo', headers: { language: 'en', 'cache-tag': 'tag:raw' } })
    equal(await body.text(), 'en:1')
  }

  await sleep(100)

  {
    const { body } = await client.request({ origin, method: 'GET', path: '/foo', headers: { language: 'en' } })
    equal(await body.text(), 'en:1')
  }

  {
    const { body } = await client.request({ origin, method: 'GET', path: '/foo', headers: { language: 'it' } })
    equal(await body.text(), 'it:2')
  }

  await store.deleteTags(['tag:raw'])

  {
    const { body } = await client.request({ origin, method: 'GET', path: '/foo', headers: { language: 'en' } })
    equal(await body.text(), 'en:3')
  }
})

test('v2 replaces same vary variant and keeps different variants', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
  t.after(() => store.close())

  const baseKey = { origin: 'https://example.com', method: 'GET', path: '/foo' }
  const baseValue = {
    statusCode: 200,
    statusMessage: '',
    headers: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 10000,
    deleteAt: Date.now() + 20000,
    cacheControlDirectives: {}
  }

  {
    const stream = store.createWriteStream({ ...baseKey, headers: { language: 'en' } }, {
      ...baseValue,
      vary: { language: 'en' }
    })
    stream.end('en-1')
    await once(stream, 'close')
  }

  {
    const stream = store.createWriteStream({ ...baseKey, headers: { language: 'it' } }, {
      ...baseValue,
      vary: { language: 'it' }
    })
    stream.end('it')
    await once(stream, 'close')
  }

  {
    const stream = store.createWriteStream({ ...baseKey, headers: { language: 'en' } }, {
      ...baseValue,
      vary: { language: 'en' }
    })
    stream.end('en-2')
    await once(stream, 'close')
  }

  const entries = await store.entries({ origin: baseKey.origin, method: baseKey.method, path: baseKey.path })
  equal(entries.length, 2)

  const en = await store.get({ ...baseKey, headers: { language: 'en' } })
  deepStrictEqual(en.body, [Buffer.from('en-2')])

  const it = await store.get({ ...baseKey, headers: { language: 'it' } })
  deepStrictEqual(it.body, [Buffer.from('it')])
})

test('v2 selects the most specific matching vary variant', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
  t.after(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/foo' }
  const value = cacheValue()

  for (const [headers, vary, body] of [
    [{}, {}, 'generic'],
    [{ language: 'en' }, { language: 'en' }, 'language'],
    [{ language: 'en', device: 'mobile' }, { language: 'en', device: 'mobile' }, 'language-device']
  ]) {
    const stream = store.createWriteStream({ ...key, headers }, { ...value, vary })
    stream.end(body)
    await once(stream, 'close')
  }

  const result = await store.get({ ...key, headers: { language: 'en', device: 'mobile' } })
  deepStrictEqual(result.body, [Buffer.from('language-device')])

  const fallback = await store.get({ ...key, headers: { language: 'en', device: 'desktop' } })
  deepStrictEqual(fallback.body, [Buffer.from('language')])
})

test('v2 deletes by origin/path across methods and by combined tags', async (t) => {
  await cleanValkey()

  const store = new RedisCache({
    prefix: `${crypto.randomUUID()}:`,
    tracking: false,
    cacheTagsHeader: 'cache-tag'
  })
  t.after(() => store.close())

  for (const [method, path, tags, body] of [
    ['GET', '/foo', 'tag1,tag2', 'a'],
    ['POST', '/foo', 'tag1,tag2,tag3', 'b'],
    ['GET', '/bar', 'tag1,tag3', 'c']
  ]) {
    const stream = store.createWriteStream({ origin: 'https://example.com', method, path }, {
      statusCode: 200,
      statusMessage: '',
      headers: { 'cache-tag': tags },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    })
    stream.end(body)
    await once(stream, 'close')
  }

  await store.delete({ origin: 'https://example.com', path: '/foo' })
  equal((await store.entries({ origin: 'https://example.com' })).length, 1)

  for (const [method, path, tags, body] of [
    ['GET', '/foo', 'tag1,tag2', 'a'],
    ['POST', '/foo', 'tag1,tag2,tag3', 'b']
  ]) {
    const stream = store.createWriteStream({ origin: 'https://example.com', method, path }, {
      statusCode: 200,
      statusMessage: '',
      headers: { 'cache-tag': tags },
      cachedAt: Date.now(),
      staleAt: Date.now() + 10000,
      deleteAt: Date.now() + 20000,
      cacheControlDirectives: {}
    })
    stream.end(body)
    await once(stream, 'close')
  }

  await store.deleteTags([['tag1', 'tag2']])
  const remaining = await store.entries({ origin: 'https://example.com' })
  equal(remaining.length, 1)
  equal(remaining[0].path, '/bar')
})

test('v2 tracking cache selects variants and evicts entries', () => {
  const cache = new TrackingCache({ maxCount: 2, maxSize: 4 })
  const base = { prefix: 'p:', origin: 'https://example.com', method: 'GET', path: '/foo' }

  equal(cache.count, 0)
  equal(cache.size, 0)
  equal(cache.get('p:', base), undefined)

  cache.set('p:', { ...base, id: 'a', specificity: 1, vary: { language: 'en' } }, { body: [Buffer.from('aa')] })
  cache.set('p:', { ...base, id: 'b', specificity: 2, vary: { language: 'en', device: 'm' } }, { body: [Buffer.from('bb')] })

  deepStrictEqual(cache.get('p:', { ...base, headers: { language: 'en', device: 'm' } }).body, [Buffer.from('bb')])
  deepStrictEqual(cache.get('p:', { ...base, headers: { language: 'en' } }).body, [Buffer.from('aa')])
  equal(cache.get('p:', { ...base, headers: { language: 'it' } }), undefined)

  cache.set('p:', { ...base, id: 'a', specificity: 1, vary: { language: 'en' } }, { body: [Buffer.from('a')] })
  equal(cache.count, 2)
  equal(cache.size, 3)

  cache.deleteEntry('p:', { ...base, id: 'missing' })
  cache.deleteEntry('p:', { ...base, id: 'a' })
  equal(cache.count, 1)

  cache.delete('p:', base)
  equal(cache.count, 0)

  cache.set('p:', { ...base, id: 'c', specificity: 0, vary: {} }, { body: [Buffer.from('ccc')] })
  cache.set('p:', { ...base, path: '/bar', id: 'd', specificity: 0, vary: {} }, { body: [Buffer.from('ddd')] })
  equal(cache.count, 1)
})

test('v2 utility helpers cover normalization and matching branches', () => {
  deepStrictEqual(serializeHeaders(undefined), {})
  deepStrictEqual(serializeHeaders({ B: '', C: undefined, A: ['one', 'two'] }), { a: 'one, two' })
  equal(serializeForHash(['a', 'b']), '["a","b"]')
  equal(encodeBodyChunk('hello'), Buffer.from('hello').toString('base64'))
  equal(encodeBodyChunk(Buffer.from('hello')), Buffer.from('hello').toString('base64'))
  deepStrictEqual(decodeBody(''), [])
  deepStrictEqual(decodeBody(`${Buffer.from('a').toString('base64')} ${Buffer.from('b').toString('base64')}`), [
    Buffer.from('a'),
    Buffer.from('b')
  ])
  equal(varyMatches({ vary: undefined }, {}), true)
  equal(varyMatches({ vary: { language: null } }, {}), true)
  equal(varyMatches({ vary: { language: 'en' } }, { language: 'en' }), true)
  equal(varyMatches({ vary: { language: 'en' } }, { language: 'it' }), false)
  equal(normalizePrefix(undefined), '')
  equal(normalizePrefix('foo:'), 'foo:')
  equal(normalizePrefix('foo'), 'foo:')
  deepStrictEqual(normalizePrefixes('foo:', undefined), ['foo:'])
  deepStrictEqual(normalizePrefixes('foo:', 'bar'), ['bar:'])
  deepStrictEqual(normalizePrefixes('foo:', ['bar', 'baz:']), ['bar:', 'baz:'])
  equal(validateHashTagPart('prefix', '', true), '')
  equal(validateHashTagPart('clusterId', 'tenant', false), 'tenant')
  throws(() => validateHashTagPart('prefix', 1, true), /prefix must be a string/)
  throws(() => validateHashTagPart('prefix', 'a{b', true), /prefix cannot contain/)
  throws(() => validateHashTagPart('clusterId', '', false), /clusterId must be a non-empty string/)
  throws(() => validateHashTagPart('clusterId', undefined, false), /clusterId must be a non-empty string/)
  deepStrictEqual(unique(['a', 'a', 'b']), ['a', 'b'])
})

test('v2 cluster hash tag key shapes are stable', async () => {
  await cleanValkey()

  async function writeAndGetKeys (opts) {
    await cleanValkey()
    const store = new RedisCache({ ...opts, tracking: false })
    try {
      await write(store, { origin: 'https://example.com', method: 'GET', path: '/foo' }, cacheValue(), 'foo')
      return await getAllKeys()
    } finally {
      await store.close()
    }
  }

  {
    const keys = await writeAndGetKeys({ prefix: '' })
    ok(keys.length > 0)
    ok(keys.every(key => key.startsWith('{data:v2}:')))
  }

  {
    const keys = await writeAndGetKeys({ prefix: 'app' })
    ok(keys.length > 0)
    ok(keys.every(key => key.startsWith('{app:data:v2}:')))
  }

  {
    const keys = await writeAndGetKeys({ prefix: '', clusterId: 'tenant-a' })
    ok(keys.length > 0)
    ok(keys.every(key => key.startsWith('{tenant-a}:data:v2:')))
  }

  {
    const keys = await writeAndGetKeys({ prefix: 'app', clusterId: 'tenant-a' })
    ok(keys.length > 0)
    ok(keys.every(key => key.startsWith('app:{tenant-a}:data:v2:')))
  }

  throws(() => new RedisCache({ prefix: 'bad{prefix}' }), /prefix cannot contain/)
  throws(() => new RedisCache({ clusterId: '' }), /clusterId must be a non-empty string/)
  throws(() => new RedisCache({ clusterId: 'bad}' }), /clusterId cannot contain/)
  throws(() => new RedisCache({ prefix: 1 }), /prefix must be a string/)
  throws(() => new RedisCache({ clusterId: 1 }), /clusterId must be a string/)
})

test('v2 exposes manager operations and multi-prefix reads', async (t) => {
  await cleanValkey()

  const prefix1 = `${crypto.randomUUID()}:`
  const prefix2 = `${crypto.randomUUID()}:`
  const store1 = new RedisCache({ prefix: prefix1, tracking: true, clientConfigTracking: false, cacheTagsHeader: 'cache-tag' })
  const store2 = new RedisCache({ prefix: prefix2, tracking: false, cacheTagsHeader: 'cache-tag' })
  t.after(async () => {
    await store1.close()
    await store1.close()
    await store2.close()
  })

  equal(store1.version, '2.0.0')
  equal(store1.dataVersion, 'v2')
  equal(store1.prefix, prefix1)
  ok(store1.client)

  throws(() => new RedisCache(null), TypeError)

  const key1 = { origin: 'https://example.com', method: 'GET', path: '/foo', headers: { language: 'en' } }
  const key2 = { origin: 'https://example.com', method: 'POST', path: '/foo' }
  const key3 = { origin: 'https://example.com', method: 'GET', path: '/bar' }

  await write(store1, key1, cacheValue({ headers: { 'cache-tag': ['tag1', 'tag2'], etag: 'abc' }, vary: { language: 'en' } }), 'foo')
  await write(store1, key2, cacheValue({ headers: { 'cache-tag': 'tag1,tag2,tag3' } }), 'post')
  await write(store2, key3, cacheValue({ headers: { 'cache-tag': 'tag2' } }), 'bar')

  const first = await store1.get(key1)
  equal(first.etag, 'abc')

  const tracked = await store1.get(key1, undefined, false)
  equal(tracked.body, undefined)
  equal(tracked.statusCode, 200)

  const multiPrefix = await store1.get(key3, [prefix1, prefix2])
  deepStrictEqual(multiPrefix.body, [Buffer.from('bar')])

  equal((await store1.getKeys([key1, { ...key1, path: '/missing' }])).length, 1)
  equal((await store1.entries()).length, 2)
  equal((await store1.entries({ id: (await store1.entries())[0].id })).length, 1)
  equal((await store1.entries({ origin: key1.origin, method: 'GET' })).length, 1)
  equal((await store1.entries({ origin: key1.origin, path: '/foo' })).length, 2)
  equal((await store1.getTag('tag1')).length, 2)
  equal((await store1.getTags(['tag1', 'tag2', 'tag1'])).length, 4)

  const streamed = []
  await store1.streamEntries(entry => streamed.push(entry))
  equal(streamed.length, 2)

  const entry = streamed.find(entry => entry.method === 'GET')
  equal(await store1.getResponseById(entry.id), 'foo')
  equal(await store1.getResponseById('missing'), null)

  const dependent = await store1.getDependentEntries(entry.id)
  equal(dependent.length, 1)
  equal((await store1.getDependentEntries('missing')).length, 0)

  await store1.deleteKeys([{ id: entry.id }])
  equal((await store1.entries()).length, 1)

  const remaining = (await store1.entries())[0]
  equal((await store1.deleteEntries({ id: remaining.id })).length, 1)
  equal((await store1.entries()).length, 0)

  await write(store1, key1, cacheValue({ headers: { 'cache-tag': 'tag1' } }), 'foo')
  await write(store1, key2, cacheValue({ headers: { 'cache-tag': 'tag2' } }), 'post')
  equal((await store1.deleteEntries({ origin: key1.origin })).length, 2)
  equal((await store1.entries()).length, 0)

  await store1.deleteTag([])
  await store1.deleteIds(['missing'])
  await store1.deleteKeys([{ id: 'missing' }])
  await store1.deleteKeys([{ origin: key1.origin, method: 'GET', path: '/missing' }])
})

test('v2 handles max entry size and closed stores', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false, maxEntrySize: 2 })
  t.after(() => store.close())

  await write(store, { origin: 'https://example.com', method: 'GET', path: '/too-big' }, cacheValue(), 'too big')
  equal((await store.entries()).length, 0)

  await store.close()
  equal(await store.get({ origin: 'https://example.com', method: 'GET', path: '/too-big' }), undefined)
  await store.delete({ origin: 'https://example.com', path: '/too-big' })
  await store.deleteKeys([{ origin: 'https://example.com', method: 'GET', path: '/too-big' }])
  await store.deleteIds(['missing'])
})

test('v2 covers error and cleanup branches', async (t) => {
  await cleanValkey()

  throws(() => new RedisCache('invalid'), /expected opts/)

  const prefix = `${crypto.randomUUID()}:`
  const store = new RedisCache({ prefix, tracking: false, cacheTagsHeader: 'cache-tag' })
  t.after(() => store.close())

  const arrayHeaderKey = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/array',
    headers: { language: ['en', 'us'] }
  }
  await write(store, arrayHeaderKey, cacheValue({ vary: { language: ['en', 'us'] } }), 'array')
  notEqual(await store.get(arrayHeaderKey), undefined)

  await write(store, { origin: 'https://example.com', method: 'GET', path: '/no-tags' }, cacheValue({ headers: { other: 'tag1' } }), 'no-tags')
  const noTags = await store.entries({ origin: 'https://example.com', method: 'GET', path: '/no-tags' })
  deepStrictEqual(noTags[0].tags, [])

  const entry = (await store.entries({ origin: 'https://example.com', method: 'GET', path: '/array' }))[0]
  const bodyKey = (await getAllKeys()).find(key => key.endsWith(`:body:${entry.id}`))
  await store.client.del(bodyKey)
  equal(await store.get(arrayHeaderKey), undefined)
})

test('v2 handles subscription errors', async (t) => {
  await cleanValkey()

  const prefix = `${crypto.randomUUID()}:`
  const errors = []
  const store = new RedisCache({ prefix, tracking: false, errorCallback: err => errors.push(err) })
  t.after(() => store.close())

  await store.subscribe()

  const malformedKey = `{${prefix}data:v2}:entry:malformed`
  await store.client.set(malformedKey, '{')
  await new Promise(resolve => setTimeout(resolve, 100))
  ok(errors.length > 0)

  await write(store, { origin: 'https://example.com', method: 'GET', path: '/foo' }, cacheValue(), 'foo')
  const first = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  const second = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  deepStrictEqual(first.body, second.body)

  const entries = await store.entries()
  await store.deleteIds(entries.map(entry => entry.id))
})

test('v2 tracking can be enabled without keyspace subscription', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, clientConfigTracking: false })
  t.after(() => store.close())

  await write(store, { origin: 'https://example.com', method: 'GET', path: '/foo' }, cacheValue(), 'foo')
  const first = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  const second = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  deepStrictEqual(first.body, second.body)
})

test('v2 default tracking subscribes to redis invalidations', async (t) => {
  await cleanValkey()

  const prefix = `${crypto.randomUUID()}:`
  const store = new RedisCache({ prefix })
  t.after(() => store.close())

  await new Promise(resolve => setTimeout(resolve, 100))

  await write(store, { origin: 'https://example.com', method: 'GET', path: '/foo' }, cacheValue(), 'foo')
  const first = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  deepStrictEqual(first.body, [Buffer.from('foo')])

  await store.client.publish('__redis__:invalidate', 'ignored-key')
  await store.client.publish('__redis__:invalidate', `${prefix}data:v2:resource:test`)
  await new Promise(resolve => setTimeout(resolve, 100))

  const second = await store.get({ origin: 'https://example.com', method: 'GET', path: '/foo' })
  deepStrictEqual(second.body, [Buffer.from('foo')])
})

test('v2 map limit waits when concurrency is reached', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false, concurrency: 1 })
  t.after(() => store.close())

  const key1 = { origin: 'https://example.com', method: 'GET', path: '/one' }
  const key2 = { origin: 'https://example.com', method: 'GET', path: '/two' }

  await write(store, key1, cacheValue(), 'one')
  await write(store, key2, cacheValue(), 'two')

  const results = await store.getKeys([key1, key2])
  equal(results.length, 2)
})

test('v2 subscription emits entry add and delete events', async (t) => {
  await cleanValkey()

  const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false, clientConfigKeyspaceEventNotify: true })
  t.after(() => store.close())

  await store.subscribe()
  await store.subscribe()

  const add = once(store, 'subscription:entry:add')
  await write(store, { origin: 'https://example.com', method: 'GET', path: '/foo' }, cacheValue(), 'foo')
  const [added] = await add
  equal(added.value.statusCode, 200)

  const del = once(store, 'subscription:entry:delete')
  await store.deleteIds([added.id])
  const [deleted] = await del
  equal(deleted.id, added.id)
})

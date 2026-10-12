'use strict'

const { test } = require('node:test')
const { strictEqual, deepStrictEqual, rejects, ok } = require('node:assert')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const { RedisCacheStore, RedisCacheManager } = require('../index.js')
const { entryId, indexField, entryKeys, indexKey, tagIndexKey } = require('../lib/keys.js')
const { writeEntry, parseIndexEntry } = require('../lib/entries.js')
const { cleanValkey } = require('./helper.js')

const request = { origin: 'http://race.local', path: '/response', method: 'GET', headers: {} }

function delayedScript (redis, matches) {
  let open, reached
  const gate = new Promise(resolve => { open = resolve })
  const waiting = new Promise(resolve => { reached = resolve })
  const client = new Proxy(redis, {
    get (target, property) {
      const fn = Reflect.get(target, property)
      if (typeof fn !== 'function') return fn
      if (property !== 'eval') return fn.bind(target)
      return (...args) => {
        if (!matches(args[0])) return fn.apply(target, args)
        reached()
        return gate.then(() => fn.apply(target, args))
      }
    }
  })
  return { client, open, waiting }
}

async function write (store, body, tags = [], vary) {
  const now = Date.now()
  const stream = store.createWriteStream(request, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'cache-tags': tags.join(',') },
    vary,
    cachedAt: now,
    staleAt: now + 60_000,
    deleteAt: now + 60_000
  })
  stream.end(Buffer.from(body))
  await once(stream, 'close')
}

async function read (store, key = request) {
  const result = await store.get(key)
  return result && Buffer.concat(result.body).toString()
}

test('an old-tag purge cannot delete a rewrite with different tags', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  const delayed = delayedScript(redis, script => script.includes("redis.call('DEL', KEYS[2]"))
  const writer = new RedisCacheStore({ tracking: false, cacheTagsHeader: 'cache-tags' })
  const purger = new RedisCacheStore({ client: delayed.client, tracking: false })
  t.after(async () => { delayed.open(); await writer.close(); await purger.close(); await redis.quit() })

  await write(writer, 'old', ['old-tag'])
  const purging = purger.deleteTags(['old-tag'])
  await delayed.waiting
  await write(writer, 'new', ['new-tag'])
  delayed.open()
  await purging
  strictEqual(await read(writer), 'new')
  await writer.deleteTags(['new-tag'])
  strictEqual(await read(writer), undefined)
})

test('a URL delete selected before a rewrite cannot delete that rewrite', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  const delayed = delayedScript(redis, script => script.includes("redis.call('DEL', KEYS[2]"))
  const writer = new RedisCacheStore({ tracking: false })
  const deleter = new RedisCacheStore({ client: delayed.client, tracking: false })
  t.after(async () => { delayed.open(); await writer.close(); await deleter.close(); await redis.quit() })
  await write(writer, 'old')
  const deleting = deleter.delete(request)
  await delayed.waiting
  await write(writer, 'new')
  delayed.open()
  await deleting
  strictEqual(await read(writer), 'new')
})

test('delayed publication keeps the body and index from the same write', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  const delayed = delayedScript(redis, script => script.includes("redis.call('SET', KEYS[2]"))
  const slow = new RedisCacheStore({ client: delayed.client, tracking: false, cacheTagsHeader: 'cache-tags' })
  const fast = new RedisCacheStore({ tracking: false, cacheTagsHeader: 'cache-tags' })
  t.after(async () => { delayed.open(); await slow.close(); await fast.close(); await redis.quit() })
  const writing = write(slow, 'slow', ['slow-tag'])
  await delayed.waiting
  await write(fast, 'fast', ['fast-tag'])
  delayed.open()
  await writing
  strictEqual(await read(fast), 'slow')
  const entry = parseIndexEntry(Object.values(await redis.hgetall(indexKey('', request)))[0])
  deepStrictEqual(entry.tags, ['slow-tag'])
  await fast.deleteTags(['slow-tag'])
  strictEqual(await read(fast), undefined)
})

test('a wrong-type metadata key does not partially replace a response', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  t.after(() => redis.quit())
  const field = indexField('GET')
  const variant = { ...request, id: entryId(request, field), field, tags: [], deleteAt: Date.now() + 60000 }
  const keys = entryKeys('', variant)
  await redis.set(keys.metadata, 'wrong type')
  await rejects(writeEntry({ redis, keyPrefix: '' }, variant, '{}'), /WRONGTYPE/)
  strictEqual(await redis.exists(keys.value, keys.index, keys.id), 0)
})

test('failed tag publication removes only its own response', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  t.after(() => redis.quit())
  const client = new Proxy(redis, {
    get (target, property) {
      const fn = Reflect.get(target, property)
      if (typeof fn !== 'function') return fn
      if (property !== 'eval') return fn.bind(target)
      return (...args) => args[0].includes("redis.call('ZADD'")
        ? Promise.reject(new Error('tag write denied'))
        : fn.apply(target, args)
    }
  })
  const field = indexField('GET')
  const variant = { ...request, id: entryId(request, field), field, tags: ['tag'], deleteAt: Date.now() + 60000 }
  await rejects(writeEntry({ redis: client, keyPrefix: '' }, variant, '{}'), /tag write denied/)
  strictEqual((await redis.keys('index:*')).length, 0)
  strictEqual((await redis.keys('values:*')).length, 0)
})

test('hot tag indexes sweep expired URLs and purge multiple bounded batches', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  t.after(() => redis.quit())
  const put = (path, ttl) => {
    const key = { ...request, path }
    const field = indexField('GET')
    return writeEntry({ redis, keyPrefix: '' }, {
      ...key, id: entryId(key, field), field, tags: ['hot'], deleteAt: Date.now() + ttl
    }, '{}')
  }
  await put('/expires', 50)
  await put('/keeper', 60_000)
  await sleep(80)
  await put('/new', 60_000)
  strictEqual(await redis.zcard(tagIndexKey('', 'hot')), 2)
  await Promise.all(Array.from({ length: 250 }, (_, i) => put(`/item/${i}`, 60_000)))
  const store = new RedisCacheStore({ client: redis, tracking: false })
  t.after(() => store.close())
  await store.deleteTags(['hot'])
  strictEqual(await redis.zcard(tagIndexKey('', 'hot')), 0)
  strictEqual((await redis.keys('index:*')).length, 0)
})

test('tracking a generic response does not hide a more specific indexed variant', async (t) => {
  await cleanValkey()
  const writer = new RedisCacheStore({ tracking: false })
  const reader = new RedisCacheStore()
  t.after(async () => { await writer.close(); await reader.close() })
  await write(writer, 'generic')
  await write(writer, 'English', [], { 'accept-language': 'en' })
  await sleep(100)
  strictEqual(await read(reader), 'generic')
  strictEqual(await read(reader, { ...request, headers: { 'Accept-Language': 'en' } }), 'English')
  strictEqual(await read(reader, { ...request, headers: { 'accept-language': 'pt' } }), 'generic')
  ok(await reader.get(request))
})

test('rewriting tag metadata does not make a subscribed manager purge the rewrite', async (t) => {
  await cleanValkey()
  const manager = new RedisCacheManager()
  const store = new RedisCacheStore({ tracking: false, cacheTagsHeader: 'cache-tags' })
  t.after(async () => { await manager.close(); await store.close() })
  await manager.subscribe()
  await write(store, 'old', ['a'])
  await write(store, 'new', ['a', 'b'])
  await sleep(100)
  strictEqual(await read(store), 'new')
})

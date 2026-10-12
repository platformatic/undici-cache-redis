'use strict'

const { test } = require('node:test')
const { strictEqual } = require('node:assert')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const { RedisCacheStore } = require('../index.js')
const { cleanValkey } = require('./helper.js')

test('a Redis error is not remembered as a URL miss', async (t) => {
  await cleanValkey()
  const redis = new Redis()
  let calls = 0
  const errors = []
  const client = new Proxy(redis, {
    get (target, property) {
      const fn = Reflect.get(target, property)
      if (typeof fn !== 'function') return fn
      if (property !== 'hgetall') return fn.bind(target)
      return (...args) => ++calls === 1 ? Promise.reject(new Error('temporary read failure')) : fn.apply(target, args)
    }
  })
  const store = new RedisCacheStore({ client, errorCallback: err => errors.push(err) })
  t.after(async () => { await store.close(); await redis.quit() })
  await sleep(100)
  const key = { origin: 'http://miss.local', path: '/', method: 'GET', headers: {} }
  strictEqual(await store.get(key), undefined)
  strictEqual(errors.length, 1)
  strictEqual(await store.get(key), undefined)
  strictEqual(calls, 2)
  strictEqual(await store.get(key), undefined)
  strictEqual(calls, 2)
})

test('a nonmatching variant is not remembered as an empty URL', async (t) => {
  await cleanValkey()
  const store = new RedisCacheStore()
  t.after(() => store.close())
  const key = { origin: 'http://miss.local', path: '/', method: 'GET', headers: {} }
  const now = Date.now()
  const stream = store.createWriteStream(key, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: {},
    vary: { 'accept-language': 'en' },
    cachedAt: now,
    staleAt: now + 60_000,
    deleteAt: now + 60_000
  })
  stream.end(Buffer.from('English'))
  await once(stream, 'close')
  await sleep(100)
  strictEqual(await store.get({ ...key, headers: { 'accept-language': 'pt' } }), undefined)
  strictEqual(Buffer.concat((await store.get({ ...key, headers: { 'accept-language': 'en' } })).body).toString(), 'English')
})

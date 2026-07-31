import { deepStrictEqual, equal, notEqual } from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { RedisCache } from '../../../index.js'
import { cleanValkey } from '../../helper.js'
import { cacheValue, writeEntry } from './helper.js'

describe('RedisCache V2 store compatibility', () => {
  test('matches store interface', async t => {
    const store = new RedisCache({ tracking: false })
    t.after(() => store.close())

    equal(typeof store.get, 'function')
    equal(typeof store.createWriteStream, 'function')
    equal(typeof store.delete, 'function')
    equal(typeof store.deleteKeys, 'function')
  })

  test('basic functionality', async t => {
    await cleanValkey()
    const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
    t.after(() => store.close())

    const key = { origin: 'localhost', path: '/', method: 'GET', headers: {} }
    const value = cacheValue({ headers: { foo: 'bar' } })
    await writeEntry(store, key, value, ['asd', '123'])

    const result = await store.get({ ...key })
    notEqual(result, undefined)
    deepStrictEqual(result.body, [Buffer.from('asd'), Buffer.from('123')])
    equal(result.headers.foo, 'bar')
  })

  test('returns stale response if possible', async t => {
    await cleanValkey()
    const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
    t.after(() => store.close())

    const key = { origin: 'localhost', path: '/', method: 'GET', headers: {} }
    const value = cacheValue({ cachedAt: Date.now() - 10000, staleAt: Date.now() - 1 })
    await writeEntry(store, key, value, 'stale')

    const result = await store.get(key)
    notEqual(result, undefined)
    deepStrictEqual(result.body, [Buffer.from('stale')])
  })

  test('does not return response past deletedAt', async t => {
    await cleanValkey()
    const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
    t.after(() => store.close())

    const key = { origin: 'localhost', path: '/', method: 'GET', headers: {} }
    await writeEntry(store, key, cacheValue({ deleteAt: Date.now() + 1000 }), 'expired')
    await sleep(1200)

    equal(await store.get(key), undefined)
  })

  test('respects vary directives', async t => {
    await cleanValkey()
    const store = new RedisCache({ prefix: `${crypto.randomUUID()}:`, tracking: false })
    t.after(() => store.close())

    const key = { origin: 'localhost', path: '/', method: 'GET', headers: { language: 'en' } }
    await writeEntry(store, key, cacheValue({ vary: { language: 'en' } }), 'en')

    notEqual(await store.get({ ...key }), undefined)
    equal(await store.get({ ...key, headers: { language: 'it' } }), undefined)
  })
})

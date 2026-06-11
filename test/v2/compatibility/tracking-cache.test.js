import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import TrackingCache from '../../../src/v2/tracking-cache.js'

test('v2 tracking cache overrides cache entries', () => {
  const cache = new TrackingCache()
  const metadata = { id: '1', origin: 'http://test.com', method: 'GET', path: '/foo' }

  cache.set('', metadata, { body: ['one'] })
  cache.set('', { ...metadata, id: '2' }, { body: ['two'] })

  strictEqual(cache.count, 2)
  deepStrictEqual(cache.get('', metadata), { body: ['one'] })
})

test('v2 tracking cache deletes values when reaching a count threshold', () => {
  const cache = new TrackingCache({ maxCount: 2 })
  cache.set('', { id: '1', origin: 'http://a.com', method: 'GET', path: '/' }, { body: ['a'] })
  cache.set('', { id: '2', origin: 'http://b.com', method: 'GET', path: '/' }, { body: ['b'] })
  cache.set('', { id: '3', origin: 'http://c.com', method: 'GET', path: '/' }, { body: ['c'] })

  strictEqual(cache.count, 2)
})

test('v2 tracking cache respects vary directives', () => {
  const cache = new TrackingCache()
  const metadata = {
    id: '1',
    origin: 'http://test.com',
    method: 'GET',
    path: '/foo',
    vary: { 'accept-encoding': 'gzip' },
    specificity: 1
  }

  cache.set('', metadata, { body: ['gzip'] })

  deepStrictEqual(cache.get('', { ...metadata, headers: { 'accept-encoding': 'gzip' } }), { body: ['gzip'] })
  strictEqual(cache.get('', { ...metadata, headers: { 'accept-encoding': 'deflate' } }), undefined)
})

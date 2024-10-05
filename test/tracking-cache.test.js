'use strict'

const { describe, test } = require('node:test')
const { deepStrictEqual, notEqual, equal } = require('node:assert')
const TrackingCache = require('../lib/tracking-cache')

describe('TrackingCache', () => {
  test('get', async () => {
    let redisCalls = 0
    const cache = new TrackingCache({
      get: (key) => {
        redisCalls++

        if (key === 'some-key') {
            return 'asd123'
        }
        
        return null
      }
    })

    // First request, should reach redis
    let value = await cache.get('some-key')
    equal(value, 'asd123')
    equal(redisCalls, 1)

    // Fetch it again, this time it shouldn't reach Redis
    value = await cache.get('some-key')
    equal(value, 'asd123')
    equal(redisCalls, 1)

    // Invalidate it & try again, should reach Redis
    cache.invalidate('some-key')

    value = await cache.get('some-key')
    equal(value, 'asd123')
    equal(redisCalls, 2)

    value = await cache.get('unknown-key')
    equal(value, null)
    equal(redisCalls, 3)
  })

  test('hget', async () => {
    let redisCalls = 0
    const cache = new TrackingCache({
      hget: (_, value) => {
        redisCalls++

        if (value === 'field1') {
          return 'asd123'
        } else if (value === 'field2') {
          return '123asd'
        }

        return null
      }
    })

    // First request, should reach redis
    let value = await cache.hget('some-key', 'field1')
    equal(value, 'asd123')
    equal(redisCalls, 1)

    value = await cache.hget('some-key', 'field1')
    equal(value, 'asd123')
    equal(redisCalls, 1)

    value = await cache.hget('some-key', 'field2')
    equal(value, '123asd')
    equal(redisCalls, 2)

    value = await cache.hget('unvalid-key', 'field1234567')
    equal(value, null)
    equal(redisCalls, 3)
  })

  test('hgetall', async () => {
    let redisCalls = 0
    const cache = new TrackingCache({
      hgetall: (key) => {
        redisCalls++

        if (key === 'some-key') {
            return {
                field1: 'asd123',
                field2: '123asd'
            }
        }

        return {}
      }
    })

    // First request, should reach redis
    let value = await cache.hgetall('some-key')
    deepStrictEqual(value, {
        field1: 'asd123',
        field2: '123asd'
    })
    equal(redisCalls, 1)
    
    value = await cache.hgetall('some-key')
    deepStrictEqual(value, {
        field1: 'asd123',
        field2: '123asd'
    })
    equal(redisCalls, 1)

    value = await cache.hgetall('unknown-key')
    deepStrictEqual(value, {})
    equal(redisCalls, 2)
  })
})

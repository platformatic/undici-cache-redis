// @ts-check
'use strict'

const { test } = require('node:test')
const { _scanByPattern: scanByPattern } = require('../lib/redis-cache-store.js')
const { ok, fail, deepStrictEqual, strictEqual } = require('node:assert')

test('scanByPattern calls callback for matching keys and handles errors', async () => {
  // Mock Redis scan behavior
  let scanCalled = 0
  const mockKeys = ['key1', 'key2']
  const ctx = {
    redis: {
      scan: async (cursor) => {
        scanCalled++
        // First call returns keys, second call ends scan
        return cursor === '0' ? ['1', mockKeys] : ['0', []]
      },
    },
    keyPrefix: '',
    abortController: { signal: { aborted: false } }
  }

  let callbackCalled = false
  await scanByPattern(ctx, '*', async (keys) => {
    callbackCalled = true
    deepStrictEqual(keys, mockKeys)
  })

  ok(callbackCalled)
  strictEqual(scanCalled, 2)
})

test('scanByPattern propagates callback errors', async () => {
  // Mock Redis scan behavior
  const mockKeys = ['key1']
  const ctx = {
    redis: {
      scan: async (cursor) => {
        return cursor === '0' ? ['1', mockKeys] : ['0', []]
      }
    },
    keyPrefix: '',
    abortController: { signal: { aborted: false } }
  }

  let errorThrown = false
  try {
    await scanByPattern(ctx, '*', async (_keys) => {
      throw new Error('callback error')
    })
  } catch (err) {
    errorThrown = true
    ok(err instanceof Error)
    ok(err.message.includes('Error(s) occurred during scanByPattern operation'))
  }
  ok(errorThrown)
})

test('scanByPattern aborts scan if abortController.signal.aborted is true', async () => {
  let scanCalled = 0
  const mockKeys = ['key1']
  const ctx = {
    redis: {
      scan: async () => {
        scanCalled++
        return ['1', mockKeys]
      }
    },
    keyPrefix: '',
    abortController: { signal: { aborted: true } }
  }

  let callbackCount = 0
  await scanByPattern(ctx, '*', async (_keys) => {
    callbackCount++
    if (callbackCount > 1) {
      fail('Callback should be called only once when aborted')
    }
  })

  strictEqual(scanCalled, 1)
  strictEqual(callbackCount, 1)
})

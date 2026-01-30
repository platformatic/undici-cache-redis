import { deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { createStore } from '../src/index.ts'

test('should use version 1', async () => {
  const store = createStore({ clientOpts: { port: 7001 } }, '1.0.0')

  await store.get({ origin: 'http://example.com', method: 'GET', path: '/' })
  await store.close()

  deepStrictEqual(store.version, '1.0.0')
})

test('should use version 2', async () => {
  const store = createStore({ clientOpts: { port: 7001 } }, '2.0.0')

  await store.get({ origin: 'http://example.com', method: 'GET', path: '/' })
  await store.close()

  deepStrictEqual(store.version, '2.0.0')
})

test('should version 2 by default', async () => {
  const store = createStore({ clientOpts: { port: 7001 } })

  await store.get({ origin: 'http://example.com', method: 'GET', path: '/' })
  await store.close()

  deepStrictEqual(store.version, '2.0.0')
})

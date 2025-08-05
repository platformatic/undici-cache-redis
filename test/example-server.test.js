'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { spawn } = require('node:child_process')

async function waitForServer (url, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        return true
      }
    } catch (err) {
      // Server not ready yet
    }
    await sleep(1000)
  }
  throw new Error(`Server failed to start at ${url}`)
}

test('example server starts and responds to health check', async (t) => {
  const server = spawn('node', ['example/server.js'], {
    env: { ...process.env, PORT: '3010' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3010')

  const response = await fetch('http://localhost:3010/health')
  assert.strictEqual(response.ok, true)

  const data = await response.json()
  assert.strictEqual(data.status, 'ok')
  assert.ok(data.timestamp)
})

test('example server returns products with cache headers', async (t) => {
  const server = spawn('node', ['example/server.js'], {
    env: { ...process.env, PORT: '3011' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3011')

  const response = await fetch('http://localhost:3011/api/products')
  assert.strictEqual(response.ok, true)
  assert.strictEqual(response.headers.get('cache-control'), 'public, max-age=300')
  assert.ok(response.headers.get('cache-tags'))

  const data = await response.json()
  assert.ok(data.products)
  assert.ok(Array.isArray(data.products))
  assert.strictEqual(typeof data.total, 'number')
})

test('example server returns individual product', async (t) => {
  const server = spawn('node', ['example/server.js'], {
    env: { ...process.env, PORT: '3012' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3012')

  const response = await fetch('http://localhost:3012/api/products/1')
  assert.strictEqual(response.ok, true)
  assert.strictEqual(response.headers.get('cache-control'), 'public, max-age=600')

  const data = await response.json()
  assert.ok(data.product)
  assert.strictEqual(data.product.id, '1')
})

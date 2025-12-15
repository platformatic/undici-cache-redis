import { ok, strictEqual } from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

async function waitForServer (url: string, maxAttempts = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        return true
      }
    } catch (err) {
      // Server not ready yet
    }
    await sleep(100)
  }
  throw new Error(`Server failed to start at ${url}`)
}

test('example server starts and responds to health check', async t => {
  const server = spawn('node', ['example/server.ts'], {
    env: { ...process.env, PORT: '3010' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3010')

  const response = await fetch('http://localhost:3010/health')
  strictEqual(response.ok, true)

  const data = (await response.json()) as Record<string, unknown>
  strictEqual(data.status, 'ok')
  ok(data.timestamp)
})

test('example server returns products with cache headers', async t => {
  const server = spawn('node', ['example/server.ts'], {
    env: { ...process.env, PORT: '3011' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3011')

  const response = await fetch('http://localhost:3011/api/products')
  strictEqual(response.ok, true)
  strictEqual(response.headers.get('cache-control'), 'public, max-age=300')
  ok(response.headers.get('cache-tags'))

  const data = (await response.json()) as Record<string, unknown>
  ok(data.products)
  ok(Array.isArray(data.products))
  strictEqual(typeof data.total, 'number')
})

test('example server returns individual product', async t => {
  const server = spawn('node', ['example/server.ts'], {
    env: { ...process.env, PORT: '3012' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    server.kill()
  })

  await waitForServer('http://localhost:3012')

  const response = await fetch('http://localhost:3012/api/products/1')
  strictEqual(response.ok, true)
  strictEqual(response.headers.get('cache-control'), 'public, max-age=600')

  const data = (await response.json()) as Record<string, { id: string }>
  ok(data.product)
  strictEqual(data.product.id, '1')
})

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

test('proxy server with no cache forwards requests', async t => {
  // Start backend server
  const backend = spawn('node', ['example/server.ts'], {
    env: { ...process.env, PORT: '3020' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  // Start proxy server
  const proxy = spawn('node', ['benchmarks/proxy-server.ts'], {
    env: {
      ...process.env,
      CACHE_TYPE: 'none',
      PROXY_PORT: '3021',
      BACKEND_URL: 'http://localhost:3020'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    backend.kill()
    proxy.kill()
  })

  await waitForServer('http://localhost:3020') // Wait for backend
  await waitForServer('http://localhost:3021') // Wait for proxy

  const response = await fetch('http://localhost:3021/health')
  strictEqual(response.ok, true)

  const data = (await response.json()) as Record<string, unknown>
  strictEqual(data.status, 'ok')
})

test('proxy server with memory cache adds cache headers', async t => {
  // Start backend server
  const backend = spawn('node', ['example/server.ts'], {
    env: { ...process.env, PORT: '3022' },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  // Start proxy server with memory cache
  const proxy = spawn('node', ['benchmarks/proxy-server.ts'], {
    env: {
      ...process.env,
      CACHE_TYPE: 'memory',
      PROXY_PORT: '3023',
      BACKEND_URL: 'http://localhost:3022'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  t.after(() => {
    backend.kill()
    proxy.kill()
  })

  await waitForServer('http://localhost:3022') // Wait for backend
  await waitForServer('http://localhost:3023') // Wait for proxy

  // First request should be a cache miss
  const response1 = await fetch('http://localhost:3023/api/products/1')
  strictEqual(response1.ok, true)
  strictEqual(response1.headers.get('x-proxy-cache'), 'MISS')

  await sleep(1000) // Let cache settle

  // Second request should be a cache hit
  const response2 = await fetch('http://localhost:3023/api/products/1')
  strictEqual(response2.ok, true)
  strictEqual(response2.headers.get('x-proxy-cache'), 'HIT')
  ok(response2.headers.get('age')) // Age header indicates cached response
})

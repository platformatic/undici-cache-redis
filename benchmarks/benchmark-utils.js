'use strict'

const autocannon = require('autocannon')
const { spawn } = require('child_process')
const { RedisCacheStore } = require('../index.js')

const BACKEND_URL = 'http://localhost:3000'
const DEFAULT_REQUESTS = [
  { method: 'GET', path: '/api/products' },
  { method: 'GET', path: '/api/products/1' },
  { method: 'GET', path: '/api/products/2' },
  { method: 'GET', path: '/api/products/category/electronics' },
  { method: 'GET', path: '/api/stats' }
]

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
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Server failed to start at ${url}`)
}

async function clearRedisCache () {
  try {
    const redisCacheStore = new RedisCacheStore({
      clientOpts: {
        host: 'localhost',
        port: 6379
      }
    })

    await redisCacheStore.deleteKeys([
      { origin: BACKEND_URL, method: 'GET', path: '/api/products' },
      { origin: BACKEND_URL, method: 'GET', path: '/api/products/1' },
      { origin: BACKEND_URL, method: 'GET', path: '/api/products/2' },
      { origin: BACKEND_URL, method: 'GET', path: '/api/products/category/electronics' },
      { origin: BACKEND_URL, method: 'GET', path: '/api/stats' }
    ])

    await redisCacheStore.close()
  } catch (err) {
    // Ignore errors - cache might not exist
  }
}

async function warmupCache (proxyUrl) {
  try {
    // Use fetch to warm up through the proxy which should use the same cache
    for (const request of DEFAULT_REQUESTS) {
      const response = await fetch(`${proxyUrl}${request.path}`, {
        method: request.method
      })
      await response.text() // Consume response
    }
    // Let cache settle
    await new Promise(resolve => setTimeout(resolve, 1000))
  } catch (err) {
    console.error('Warmup error:', err.message)
  }
}

function formatResults (result, scenarioName) {
  return `
Results (${scenarioName}):
  Requests/sec: ${result.requests.average}
  Latency (avg): ${result.latency.average}ms
  Latency (p95): ${result.latency.p97_5 || 'N/A'}ms
  Latency (p99): ${result.latency.p99 || 'N/A'}ms
  Total requests: ${result.requests.total}
  Total duration: ${result.duration}s
  `
}

async function runProxyBenchmark (options = {}) {
  const {
    cacheType = 'none',
    proxyPort = 3001,
    scenarioName = 'Proxy',
    needsWarmup = false,
    needsCacheCleanup = false
  } = options

  const proxyUrl = `http://localhost:${proxyPort}`

  console.log(`🔥 Benchmarking: Proxy Server FOO -> Backend B (${scenarioName})`)
  console.log('='.repeat(50))

  // Clear Redis cache if needed
  if (needsCacheCleanup) {
    await clearRedisCache()
  }

  // Start proxy server
  const proxy = spawn('node', ['benchmarks/proxy-server.js'], {
    env: {
      ...process.env,
      CACHE_TYPE: cacheType,
      PROXY_PORT: proxyPort,
      BACKEND_URL
    },
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'pipe'] // Show stdout for cache debugging
  })

  // Log proxy errors for debugging
  proxy.stderr.on('data', (data) => {
    console.error(`Proxy server error: ${data}`)
  })

  try {
    // Wait for proxy to be ready
    await waitForServer(proxyUrl)

    // Warm up cache if needed
    if (needsWarmup) {
      console.log('Warming up cache...')
      await warmupCache(proxyUrl)
      console.log('Running benchmark with warmed cache...')
    }

    // Run benchmark
    const result = await autocannon({
      url: proxyUrl,
      connections: 10,
      pipelining: 1,
      duration: 30,
      requests: DEFAULT_REQUESTS
    })

    console.log(formatResults(result, scenarioName))
    return result
  } finally {
    // Stop proxy server
    proxy.kill()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

module.exports = {
  runProxyBenchmark,
  waitForServer,
  clearRedisCache,
  warmupCache,
  formatResults,
  DEFAULT_REQUESTS,
  BACKEND_URL
}

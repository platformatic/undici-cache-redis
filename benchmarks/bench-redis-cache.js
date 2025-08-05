'use strict'

const autocannon = require('autocannon')
const { Client, interceptors } = require('undici')
const { RedisCacheStore } = require('../index.js')

const API_BASE_URL = 'http://localhost:3000'

async function benchmarkRedisCache () {
  console.log('⚡ Benchmarking: Redis Cache')
  console.log('=' .repeat(50))

  const redisCacheStore = new RedisCacheStore({
    clientOpts: {
      host: 'localhost',
      port: 6379
    },
    cacheTagsHeader: 'Cache-Tags',
    tracking: true,
    maxSize: 100 * 1024 * 1024, // 100MB
    maxCount: 10000
  })

  const client = new Client(API_BASE_URL)
    .compose(interceptors.cache({ store: redisCacheStore }))

  // Clear any existing cache
  try {
    await redisCacheStore.deleteKeys([
      { origin: API_BASE_URL, method: 'GET', path: '/api/products' },
      { origin: API_BASE_URL, method: 'GET', path: '/api/products/1' },
      { origin: API_BASE_URL, method: 'GET', path: '/api/products/2' },
      { origin: API_BASE_URL, method: 'GET', path: '/api/products/category/electronics' },
      { origin: API_BASE_URL, method: 'GET', path: '/api/stats' }
    ])
  } catch (err) {
    // Ignore errors
  }

  // Warm up the cache
  console.log('Warming up Redis cache...')
  await client.request({ method: 'GET', path: '/api/products' })
  await client.request({ method: 'GET', path: '/api/products/1' })
  await client.request({ method: 'GET', path: '/api/products/2' })
  await client.request({ method: 'GET', path: '/api/products/category/electronics' })
  await client.request({ method: 'GET', path: '/api/stats' })

  // Let cache settle
  await new Promise(resolve => setTimeout(resolve, 1000))

  console.log('Running benchmark with warmed Redis cache...')

  const result = await autocannon({
    url: API_BASE_URL,
    connections: 10,
    pipelining: 1,
    duration: 30,
    requests: [
      { method: 'GET', path: '/api/products' },
      { method: 'GET', path: '/api/products/1' },
      { method: 'GET', path: '/api/products/2' },
      { method: 'GET', path: '/api/products/category/electronics' },
      { method: 'GET', path: '/api/stats' }
    ]
  })

  await client.close()
  await redisCacheStore.close()

  console.log(`
Results (Redis Cache):
  Requests/sec: ${result.requests.average}
  Latency (p95): ${result.latency.p95}ms
  Latency (avg): ${result.latency.average}ms
  Total requests: ${result.requests.total}
  Total duration: ${result.duration}s
  `)

  return result
}

if (require.main === module) {
  benchmarkRedisCache().catch(console.error)
}

module.exports = benchmarkRedisCache
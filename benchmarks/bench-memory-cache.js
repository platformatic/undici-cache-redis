'use strict'

const autocannon = require('autocannon')
const { Client, interceptors } = require('undici')

const API_BASE_URL = 'http://localhost:3000'

// Simple in-memory cache implementation
class MemoryCache {
  constructor () {
    this.cache = new Map()
    this.maxSize = 1000
  }

  createKey (request) {
    return `${request.method}:${request.origin || ''}${request.path}`
  }

  get (key) {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    // Check TTL
    if (Date.now() > entry.expiry) {
      this.cache.delete(key)
      return undefined
    }

    return entry.value
  }

  put (key, value) {
    // Simple LRU: remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }

    const ttl = 300000 // 5 minutes
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl
    })
  }

  createWriteStream (key, value) {
    const stream = require('stream')
    const writable = new stream.Writable({
      write (chunk, encoding, callback) {
        callback()
      }
    })

    writable.on('finish', () => {
      this.put(key, value)
    })

    return writable
  }

  delete () {
    // No-op for benchmark
  }

  deleteKeys () {
    // No-op for benchmark
  }
}

async function benchmarkMemoryCache () {
  console.log('💾 Benchmarking: In-Memory Cache')
  console.log('=' .repeat(50))

  const memoryCache = new MemoryCache()
  const client = new Client(API_BASE_URL)
    .compose(interceptors.cache({ store: memoryCache }))

  // Warm up the cache
  console.log('Warming up cache...')
  await client.request({ method: 'GET', path: '/api/products' })
  await client.request({ method: 'GET', path: '/api/products/1' })
  await client.request({ method: 'GET', path: '/api/products/2' })
  await client.request({ method: 'GET', path: '/api/products/category/electronics' })
  await client.request({ method: 'GET', path: '/api/stats' })

  console.log('Running benchmark with warmed cache...')

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

  console.log(`
Results (Memory Cache):
  Requests/sec: ${result.requests.average}
  Latency (p95): ${result.latency.p95}ms
  Latency (avg): ${result.latency.average}ms
  Total requests: ${result.requests.total}
  Total duration: ${result.duration}s
  Cache size: ${memoryCache.cache.size} entries
  `)

  return result
}

if (require.main === module) {
  benchmarkMemoryCache().catch(console.error)
}

module.exports = benchmarkMemoryCache
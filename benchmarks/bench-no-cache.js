'use strict'

const autocannon = require('autocannon')
const { Client } = require('undici')

const API_BASE_URL = 'http://localhost:3000'

async function benchmarkNoCache () {
  console.log('🔥 Benchmarking: No Cache (Direct API calls)')
  console.log('=' .repeat(50))

  const client = new Client(API_BASE_URL)

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
Results (No Cache):
  Requests/sec: ${result.requests.average}
  Latency (p95): ${result.latency.p95}ms
  Latency (avg): ${result.latency.average}ms
  Total requests: ${result.requests.total}
  Total duration: ${result.duration}s
  `)

  return result
}

if (require.main === module) {
  benchmarkNoCache().catch(console.error)
}

module.exports = benchmarkNoCache
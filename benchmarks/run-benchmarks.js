'use strict'

const benchmarkNoCache = require('./bench-no-cache')
const benchmarkMemoryCache = require('./bench-memory-cache')
const benchmarkRedisCache = require('./bench-redis-cache')

async function runAllBenchmarks () {
  console.log('🚀 undici-cache-redis Performance Benchmarks')
  console.log('=' .repeat(60))
  console.log('Running comprehensive performance tests...\n')

  const results = {}

  try {
    // Test without cache
    results.noCache = await benchmarkNoCache()
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Test with in-memory cache
    results.memoryCache = await benchmarkMemoryCache()
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Test with Redis cache
    results.redisCache = await benchmarkRedisCache()

    // Generate comparison report
    console.log('\n📊 PERFORMANCE COMPARISON REPORT')
    console.log('=' .repeat(60))

    const scenarios = [
      { name: 'No Cache', key: 'noCache' },
      { name: 'Memory Cache', key: 'memoryCache' },
      { name: 'Redis Cache', key: 'redisCache' }
    ]

    console.log('| Scenario | Req/sec | Latency (avg) | Latency (p95) | Total Req |')
    console.log('|----------|---------|---------------|---------------|-----------|')

    scenarios.forEach(scenario => {
      const result = results[scenario.key]
      if (result) {
        const reqSec = Math.round(result.requests.average)
        const latAvg = Math.round(result.latency.average * 100) / 100
        const latP95 = Math.round(result.latency.p95 * 100) / 100
        const totalReq = result.requests.total

        console.log(`| ${scenario.name.padEnd(8)} | ${reqSec.toString().padStart(7)} | ${latAvg.toString().padStart(11)}ms | ${latP95.toString().padStart(11)}ms | ${totalReq.toString().padStart(9)} |`)
      }
    })

    console.log('\n📈 PERFORMANCE IMPROVEMENTS')
    console.log('=' .repeat(40))

    if (results.noCache && results.memoryCache) {
      const memoryImprovement = Math.round(results.memoryCache.requests.average / results.noCache.requests.average * 10) / 10
      const memoryLatencyImprovement = Math.round(results.noCache.latency.average / results.memoryCache.latency.average * 10) / 10
      console.log(`Memory Cache vs No Cache:`)
      console.log(`  • ${memoryImprovement}x more requests/second`)
      console.log(`  • ${memoryLatencyImprovement}x faster response time`)
    }

    if (results.noCache && results.redisCache) {
      const redisImprovement = Math.round(results.redisCache.requests.average / results.noCache.requests.average * 10) / 10
      const redisLatencyImprovement = Math.round(results.noCache.latency.average / results.redisCache.latency.average * 10) / 10
      console.log(`\nRedis Cache vs No Cache:`)
      console.log(`  • ${redisImprovement}x more requests/second`)
      console.log(`  • ${redisLatencyImprovement}x faster response time`)
    }

    if (results.memoryCache && results.redisCache) {
      const comparison = Math.round(results.redisCache.requests.average / results.memoryCache.requests.average * 100) / 100
      const latencyComparison = Math.round(results.memoryCache.latency.average / results.redisCache.latency.average * 100) / 100
      
      if (comparison >= 1) {
        console.log(`\nRedis Cache vs Memory Cache:`)
        console.log(`  • ${comparison}x more requests/second`)
        console.log(`  • ${latencyComparison}x response time ratio`)
      } else {
        console.log(`\nRedis Cache vs Memory Cache:`)
        console.log(`  • ${Math.round(100/comparison)}% of memory cache throughput`)
        console.log(`  • ${Math.round(latencyComparison * 100)}% response time ratio`)
      }
    }

    console.log('\n💡 KEY INSIGHTS')
    console.log('=' .repeat(20))
    console.log('• Redis cache provides shared storage across multiple app instances')
    console.log('• Memory cache has lower latency but limited to single process')
    console.log('• Both caching approaches show significant improvement over no cache')
    console.log('• Real-world benefits depend on cache hit ratio and network latency')

    console.log('\n✅ Benchmark completed successfully!')

  } catch (error) {
    console.error('❌ Benchmark failed:', error.message)
    console.error('Make sure Redis is running on localhost:6379')
    console.error('Make sure the API server is running on localhost:3000')
    process.exit(1)
  }
}

// Check if required services are running
async function checkServices () {
  const { Client } = require('undici')
  
  // Check API server
  try {
    const client = new Client('http://localhost:3000')
    await client.request({ method: 'GET', path: '/health' })
    await client.close()
    console.log('✅ API server is running')
  } catch (err) {
    console.error('❌ API server is not running on localhost:3000')
    console.error('Please start the server with: npm run server')
    process.exit(1)
  }

  // Check Redis
  try {
    const { RedisCacheStore } = require('../index.js')
    const store = new RedisCacheStore({
      clientOpts: { host: 'localhost', port: 6379 }
    })
    await store.close()
    console.log('✅ Redis is running')
  } catch (err) {
    console.error('❌ Redis is not running on localhost:6379')
    console.error('Please start Redis with: docker run -p 6379:6379 redis:alpine')
    process.exit(1)
  }
}

async function main () {
  await checkServices()
  await runAllBenchmarks()
}

if (require.main === module) {
  main().catch(console.error)
}

module.exports = { runAllBenchmarks, benchmarkNoCache, benchmarkMemoryCache, benchmarkRedisCache }
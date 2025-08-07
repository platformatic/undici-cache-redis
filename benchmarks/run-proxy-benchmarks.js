'use strict'

const benchProxyNoCache = require('./bench-proxy-no-cache')
const benchProxyMemoryCache = require('./bench-proxy-memory-cache')
const benchProxyRedisCache = require('./bench-proxy-redis-cache')

function formatValue (value, decimals = 2) {
  return value ? value.toFixed(decimals) : 'N/A'
}

function calculateImprovement (baseline, current) {
  if (!baseline || !current) return 'N/A'
  return (current / baseline).toFixed(2)
}

function calculateReduction (baseline, current) {
  if (!baseline || !current) return 'N/A'
  return (((baseline - current) / baseline) * 100).toFixed(1)
}

async function runAllBenchmarks () {
  console.log('🚀 Running All Proxy Benchmarks')
  console.log('='.repeat(60))
  console.log('Architecture: Autocannon -> Server FOO (proxy) -> Server Bar (backend)')
  console.log('='.repeat(60))
  console.log()

  const results = {}

  try {
    // Run benchmarks sequentially
    console.log('1/3: Running No Cache benchmark...')
    results.noCache = await benchProxyNoCache()
    console.log()

    console.log('2/3: Running Memory Cache benchmark...')
    results.memoryCache = await benchProxyMemoryCache()
    console.log()

    console.log('3/3: Running Redis Cache benchmark...')
    results.redisCache = await benchProxyRedisCache()
    console.log()

    // Summary
    console.log('='.repeat(60))
    console.log('📊 BENCHMARK SUMMARY')
    console.log('='.repeat(60))
    console.log()
    console.log('Architecture: Autocannon -> Server FOO (proxy) -> Server Bar (backend)')
    console.log()

    // Requests per second comparison
    console.log('Average Requests/Second:')
    console.log(`  No Cache:     ${formatValue(results.noCache.requests.average)}`)
    console.log(`  Memory Cache: ${formatValue(results.memoryCache.requests.average)} (${calculateImprovement(results.noCache.requests.average, results.memoryCache.requests.average)}x improvement)`)
    console.log(`  Redis Cache:  ${formatValue(results.redisCache.requests.average)} (${calculateImprovement(results.noCache.requests.average, results.redisCache.requests.average)}x improvement)`)
    console.log()

    // Average latency comparison
    console.log('Average Latency (ms):')
    console.log(`  No Cache:     ${formatValue(results.noCache.latency.average)}`)
    console.log(`  Memory Cache: ${formatValue(results.memoryCache.latency.average)} (${calculateReduction(results.noCache.latency.average, results.memoryCache.latency.average)}% reduction)`)
    console.log(`  Redis Cache:  ${formatValue(results.redisCache.latency.average)} (${calculateReduction(results.noCache.latency.average, results.redisCache.latency.average)}% reduction)`)
    console.log()

    // 95th percentile latency
    console.log('95th Percentile Latency (ms):')
    console.log(`  No Cache:     ${formatValue(results.noCache.latency.p97_5)}`)
    console.log(`  Memory Cache: ${formatValue(results.memoryCache.latency.p97_5)}`)
    console.log(`  Redis Cache:  ${formatValue(results.redisCache.latency.p97_5)}`)
    console.log()

    // 99th percentile latency
    console.log('99th Percentile Latency (ms):')
    console.log(`  No Cache:     ${formatValue(results.noCache.latency.p99)}`)
    console.log(`  Memory Cache: ${formatValue(results.memoryCache.latency.p99)}`)
    console.log(`  Redis Cache:  ${formatValue(results.redisCache.latency.p99)}`)
    console.log()

    // Total requests
    console.log('Total Requests:')
    console.log(`  No Cache:     ${results.noCache.requests.total}`)
    console.log(`  Memory Cache: ${results.memoryCache.requests.total}`)
    console.log(`  Redis Cache:  ${results.redisCache.requests.total}`)
    console.log()

    // Key insights
    console.log('🎯 Key Insights:')
    const memoryImprovement = calculateImprovement(results.noCache.requests.average, results.memoryCache.requests.average)
    const redisImprovement = calculateImprovement(results.noCache.requests.average, results.redisCache.requests.average)
    const avgLatencyReduction = calculateReduction(results.noCache.latency.average, results.memoryCache.latency.average)

    if (memoryImprovement !== 'N/A') {
      console.log(`  • Memory cache provides ${memoryImprovement}x throughput improvement`)
    }
    if (redisImprovement !== 'N/A') {
      console.log(`  • Redis cache provides ${redisImprovement}x throughput improvement`)
    }
    if (avgLatencyReduction !== 'N/A') {
      console.log(`  • Up to ${avgLatencyReduction}% reduction in average latency`)
    }
    console.log('  • Shared cache benefit: Redis cache works across multiple proxy instances')
    console.log()

    console.log('='.repeat(60))
  } catch (error) {
    console.error('Error running benchmarks:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  runAllBenchmarks()
}

module.exports = runAllBenchmarks

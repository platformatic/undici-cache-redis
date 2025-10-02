'use strict'

const benchProxyNoCache = require('./bench-proxy-no-cache')
const benchProxyMemoryCache = require('./bench-proxy-memory-cache')
const benchProxyRedisOnlyCache = require('./bench-proxy-redis-cache-only')
const benchProxyRedisTrackingCache = require('./bench-proxy-redis-cache-tracking')

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
    console.log('1/4: Running No Cache benchmark...')
    results.noCache = await benchProxyNoCache()
    console.log()

    console.log('2/4: Running Memory Cache benchmark...')
    results.memoryCache = await benchProxyMemoryCache()
    console.log()

    console.log('3/4: Running Redis Cache benchmark...')
    results.redisOnlyCache = await benchProxyRedisOnlyCache()
    console.log()

    console.log('4/4: Running Redis with Tracking Cache benchmark...')
    results.redisTrackingCache = await benchProxyRedisTrackingCache()
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
    console.log(`  No Cache:              ${formatValue(results.noCache.requests.average)}`)
    console.log(`  Memory Cache:          ${formatValue(results.memoryCache.requests.average)} (${calculateImprovement(results.noCache.requests.average, results.memoryCache.requests.average)}x improvement)`)
    console.log(`  Redis Cache:           ${formatValue(results.redisOnlyCache.requests.average)} (${calculateImprovement(results.noCache.requests.average, results.redisOnlyCache.requests.average)}x improvement)`)
    console.log(`  Redis Tracking Cache:  ${formatValue(results.redisTrackingCache.requests.average)} (${calculateImprovement(results.noCache.requests.average, results.redisTrackingCache.requests.average)}x improvement)`)
    console.log()

    // Average latency comparison
    console.log('Average Latency (ms):')
    console.log(`  No Cache:              ${formatValue(results.noCache.latency.average)}`)
    console.log(`  Memory Cache:          ${formatValue(results.memoryCache.latency.average)} (${calculateReduction(results.noCache.latency.average, results.memoryCache.latency.average)}% reduction)`)
    console.log(`  Redis Cache:           ${formatValue(results.redisOnlyCache.latency.average)} (${calculateReduction(results.noCache.latency.average, results.redisOnlyCache.latency.average)}% reduction)`)
    console.log(`  Redis Tracking Cache:  ${formatValue(results.redisTrackingCache.latency.average)} (${calculateReduction(results.noCache.latency.average, results.redisTrackingCache.latency.average)}% reduction)`)
    console.log()

    // 95th percentile latency
    console.log('95th Percentile Latency (ms):')
    console.log(`  No Cache:              ${formatValue(results.noCache.latency.p97_5)} (${calculateReduction(results.noCache.latency.p97_5, results.memoryCache.latency.p97_5)}% reduction)`)
    console.log(`  Memory Cache:          ${formatValue(results.memoryCache.latency.p97_5)} (${calculateReduction(results.noCache.latency.p97_5, results.memoryCache.latency.p97_5)}% reduction)`)
    console.log(`  Redis Cache:           ${formatValue(results.redisOnlyCache.latency.p97_5)} (${calculateReduction(results.noCache.latency.p97_5, results.redisOnlyCache.latency.p97_5)}% reduction)`)
    console.log(`  Redis Tracking Cache:  ${formatValue(results.redisTrackingCache.latency.p97_5)} (${calculateReduction(results.noCache.latency.p97_5, results.redisTrackingCache.latency.p97_5)}% reduction)`)
    console.log()

    // 99th percentile latency
    console.log('99th Percentile Latency (ms):')
    console.log(`  No Cache:              ${formatValue(results.noCache.latency.p99)} (${calculateReduction(results.noCache.latency.p99, results.memoryCache.latency.p99)}% reduction)`)
    console.log(`  Memory Cache:          ${formatValue(results.memoryCache.latency.p99)} (${calculateReduction(results.noCache.latency.p99, results.memoryCache.latency.p99)}% reduction)`)
    console.log(`  Redis Cache:           ${formatValue(results.redisOnlyCache.latency.p99)} (${calculateReduction(results.noCache.latency.p99, results.redisOnlyCache.latency.p99)}% reduction)`)
    console.log(`  Redis Tracking Cache:  ${formatValue(results.redisTrackingCache.latency.p99)} (${calculateReduction(results.noCache.latency.p99, results.redisTrackingCache.latency.p99)}% reduction)`)
    console.log()

    // Total requests
    console.log('Total Requests:')
    console.log(`  No Cache:              ${results.noCache.requests.total}`)
    console.log(`  Memory Cache:          ${results.memoryCache.requests.total}`)
    console.log(`  Redis Cache:           ${results.redisOnlyCache.requests.total}`)
    console.log(`  Redis Tracking Cache:  ${results.redisTrackingCache.requests.total}`)
    console.log()

    // Key insights
    console.log('🎯 Key Insights:')
    const memoryImprovement = calculateImprovement(results.noCache.requests.average, results.memoryCache.requests.average)
    const memoryLatencyReduction = calculateReduction(results.noCache.latency.average, results.memoryCache.latency.average)
    const redisOnlyImprovement = calculateImprovement(results.noCache.requests.average, results.redisOnlyCache.requests.average)
    const redisOnlyLatencyReduction = calculateReduction(results.noCache.latency.average, results.redisOnlyCache.latency.average)
    const redisTrackingImprovement = calculateImprovement(results.noCache.requests.average, results.redisTrackingCache.requests.average)
    const redisTrackingLatencyReduction = calculateReduction(results.noCache.latency.average, results.redisTrackingCache.latency.average)

    console.log(`
                              Throughput |    Latency
  Memory cache                ${memoryImprovement.padStart(9)}x | ${memoryLatencyReduction.padStart(9)}%
  Redis cache only            ${redisOnlyImprovement.padStart(9)}x | ${redisOnlyLatencyReduction.padStart(9)}%
  Redis with tracking cache   ${redisTrackingImprovement.padStart(9)}x | ${redisTrackingLatencyReduction.padStart(9)}%

  Shared cache benefit: Redis cache works across multiple proxy instances.
  Throughput improvement and latency reduction are relative to the no-cache baseline.
`)

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

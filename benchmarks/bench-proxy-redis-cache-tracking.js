'use strict'

const { runProxyBenchmark } = require('./benchmark-utils')

async function benchmarkProxyRedisTrackingCache () {
  const result = await runProxyBenchmark({
    cacheType: 'redis-tracking',
    proxyPort: 3003,
    scenarioName: 'Redis Cache + Tracking Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (require.main === module) {
  benchmarkProxyRedisTrackingCache().catch(console.error)
}

module.exports = benchmarkProxyRedisTrackingCache

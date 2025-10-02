'use strict'

const { runProxyBenchmark } = require('./benchmark-utils')

async function benchmarkProxyRedisOnlyCache () {
  const result = await runProxyBenchmark({
    cacheType: 'redis-only',
    proxyPort: 3003,
    scenarioName: 'Redis Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (require.main === module) {
  benchmarkProxyRedisOnlyCache().catch(console.error)
}

module.exports = benchmarkProxyRedisOnlyCache

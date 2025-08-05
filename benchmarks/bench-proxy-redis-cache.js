'use strict'

const { runProxyBenchmark } = require('./benchmark-utils')

async function benchmarkProxyRedisCache () {
  const result = await runProxyBenchmark({
    cacheType: 'redis',
    proxyPort: 3003,
    scenarioName: 'Redis Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (require.main === module) {
  benchmarkProxyRedisCache().catch(console.error)
}

module.exports = benchmarkProxyRedisCache

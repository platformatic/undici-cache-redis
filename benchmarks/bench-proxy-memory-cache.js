'use strict'

const { runProxyBenchmark } = require('./benchmark-utils')

async function benchmarkProxyMemoryCache () {
  const result = await runProxyBenchmark({
    cacheType: 'memory',
    proxyPort: 3002,
    scenarioName: 'Memory Cache',
    needsWarmup: true,
    needsCacheCleanup: false
  })

  return result
}

if (require.main === module) {
  benchmarkProxyMemoryCache().catch(console.error)
}

module.exports = benchmarkProxyMemoryCache

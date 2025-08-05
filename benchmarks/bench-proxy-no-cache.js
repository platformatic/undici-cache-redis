'use strict'

const { runProxyBenchmark } = require('./benchmark-utils')

async function benchmarkProxyNoCache () {
  const result = await runProxyBenchmark({
    cacheType: 'none',
    proxyPort: 3001,
    scenarioName: 'No Cache',
    needsWarmup: false,
    needsCacheCleanup: false
  })

  return result
}

if (require.main === module) {
  benchmarkProxyNoCache().catch(console.error)
}

module.exports = benchmarkProxyNoCache

import { pathToFileURL } from 'node:url'
import { runProxyBenchmark } from './benchmark-utils.js'

export default async function benchmarkProxyRedisTrackingCache () {
  const result = await runProxyBenchmark({
    cacheType: 'redis-tracking',
    proxyPort: 3003,
    scenarioName: 'Redis Cache + Tracking Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  benchmarkProxyRedisTrackingCache().catch(console.error)
}

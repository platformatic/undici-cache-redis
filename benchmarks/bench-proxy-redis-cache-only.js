import { pathToFileURL } from 'node:url'
import { runProxyBenchmark } from './benchmark-utils.js'

export default async function benchmarkProxyRedisOnlyCache () {
  const result = await runProxyBenchmark({
    cacheType: 'redis-only',
    proxyPort: 3003,
    scenarioName: 'Redis Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  benchmarkProxyRedisOnlyCache().catch(console.error)
}

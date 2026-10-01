import { pathToFileURL } from 'node:url'
import { runProxyBenchmark } from './benchmark-utils.js'

export default async function benchmarkProxyMemoryCache () {
  const result = await runProxyBenchmark({
    cacheType: 'memory',
    proxyPort: 3002,
    scenarioName: 'Memory Cache',
    needsWarmup: true,
    needsCacheCleanup: false
  })

  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  benchmarkProxyMemoryCache().catch(console.error)
}

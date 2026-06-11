import { pathToFileURL } from 'node:url'
import { runProxyBenchmark } from './benchmark-utils.js'

export default async function benchmarkProxyNoCache () {
  const result = await runProxyBenchmark({
    cacheType: 'none',
    proxyPort: 3001,
    scenarioName: 'No Cache',
    needsWarmup: false,
    needsCacheCleanup: false
  })

  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  benchmarkProxyNoCache().catch(console.error)
}

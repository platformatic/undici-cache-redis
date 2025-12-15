import { type Result } from 'autocannon'
import { runProxyBenchmark } from './benchmark-utils.ts'

export async function benchmarkProxyMemoryCache (): Promise<Result> {
  const result = await runProxyBenchmark({
    cacheType: 'memory',
    proxyPort: 3002,
    scenarioName: 'Memory Cache',
    needsWarmup: true,
    needsCacheCleanup: false
  })

  return result
}

if (import.meta.main) {
  benchmarkProxyMemoryCache().catch(console.error)
}

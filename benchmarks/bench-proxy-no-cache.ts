import { type Result } from 'autocannon'
import { runProxyBenchmark } from './benchmark-utils.ts'

export async function benchmarkProxyNoCache (): Promise<Result> {
  const result = await runProxyBenchmark({
    cacheType: 'none',
    proxyPort: 3001,
    scenarioName: 'No Cache',
    needsWarmup: false,
    needsCacheCleanup: false
  })

  return result
}

if (import.meta.main) {
  benchmarkProxyNoCache().catch(console.error)
}

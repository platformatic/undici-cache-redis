import { type Result } from 'autocannon'
import { runProxyBenchmark } from './benchmark-utils.ts'

export async function benchmarkProxyRedisOnlyCache (): Promise<Result> {
  const result = await runProxyBenchmark({
    cacheType: 'redis-only',
    proxyPort: 3003,
    scenarioName: 'Redis Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (import.meta.main) {
  benchmarkProxyRedisOnlyCache().catch(console.error)
}

import { type Result } from 'autocannon'
import { runProxyBenchmark } from './benchmark-utils.ts'

export async function benchmarkProxyRedisTrackingCache (): Promise<Result> {
  const result = await runProxyBenchmark({
    cacheType: 'redis-tracking',
    proxyPort: 3003,
    scenarioName: 'Redis Cache + Tracking Cache',
    needsWarmup: true,
    needsCacheCleanup: true
  })

  return result
}

if (import.meta.main) {
  benchmarkProxyRedisTrackingCache().catch(console.error)
}

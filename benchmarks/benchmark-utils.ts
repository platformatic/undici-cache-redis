import autocannon, { type Request, type Result } from 'autocannon'
import { spawn } from 'node:child_process'
import { createStore } from '../src/index.ts'

interface RunProxyBenchmarkOptions {
  cacheType?: string
  proxyPort?: number
  scenarioName?: string
  needsWarmup?: boolean
  needsCacheCleanup?: boolean
}

export const BACKEND_URL = 'http://localhost:3000'
export const DEFAULT_REQUESTS: Request[] = [
  { method: 'GET', path: '/api/products' },
  { method: 'GET', path: '/api/products/category/electronics' },
  { method: 'GET', path: '/api/stats' }
]

const KEYS_TO_DELETE = [
  { origin: BACKEND_URL, method: 'GET', path: '/api/products' },
  { origin: BACKEND_URL, method: 'GET', path: '/api/products/category/electronics' },
  { origin: BACKEND_URL, method: 'GET', path: '/api/stats' }
]

for (let i = 1; i <= 500; i++) {
  DEFAULT_REQUESTS.push({ method: 'GET', path: `/api/products/${i}` })
  KEYS_TO_DELETE.push({ origin: BACKEND_URL, method: 'GET', path: `/api/products/${i}` })
}

export async function waitForServer (url: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        return true
      }
    } catch (err) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Server failed to start at ${url}`)
}

export async function clearRedisCache (): Promise<void> {
  try {
    const redisCacheStore = createStore({
      clientOpts: {
        host: 'localhost',
        port: 7001
      }
    })

    await redisCacheStore.deleteKeys(KEYS_TO_DELETE)

    await redisCacheStore.close()
  } catch (err) {
    // Ignore errors - cache might not exist
  }
}

export async function warmupCache (proxyUrl: string): Promise<void> {
  try {
    // Use fetch to warm up through the proxy which should use the same cache
    for (const request of DEFAULT_REQUESTS) {
      const response = await fetch(`${proxyUrl}${request.path}`, {
        method: request.method
      })
      await response.text() // Consume response
    }
    // Let cache settle
    await new Promise(resolve => setTimeout(resolve, 1000))
  } catch (err) {
    console.error('Warmup error:', (err as Error).message)
  }
}

export function formatResults (result: Result, scenarioName: string): string {
  return `
Results (${scenarioName}):
  Requests/sec: ${result.requests.average}
  Latency (avg): ${result.latency.average}ms
  Latency (p95): ${result.latency.p97_5 || 'N/A'}ms
  Latency (p99): ${result.latency.p99 || 'N/A'}ms
  Total requests: ${result.requests.total}
  Total duration: ${result.duration}s
  `
}

export async function runProxyBenchmark (options: RunProxyBenchmarkOptions = {}): Promise<Result> {
  const {
    cacheType = 'none',
    proxyPort = 3001,
    scenarioName = 'Proxy',
    needsWarmup = false,
    needsCacheCleanup = false
  } = options

  const proxyUrl = `http://localhost:${proxyPort}`

  console.log(`🔥 Benchmarking: Proxy Server FOO -> Backend B (${scenarioName})`)
  console.log('='.repeat(50))

  // Clear Redis cache if needed
  if (needsCacheCleanup) {
    await clearRedisCache()
  }

  // Start proxy server
  const proxy = spawn('node', ['benchmarks/proxy-server.ts'], {
    env: {
      ...process.env,
      CACHE_TYPE: cacheType,
      PROXY_PORT: proxyPort.toString(),
      BACKEND_URL
    },
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'pipe'] // Show stdout for cache debugging
  })

  // Log proxy errors for debugging
  proxy.stderr.on('data', data => {
    console.error(`Proxy server error: ${data}`)
  })

  try {
    // Wait for proxy to be ready
    await waitForServer(proxyUrl)

    // Warm up cache if needed
    if (needsWarmup) {
      console.log('Warming up cache...')
      await warmupCache(proxyUrl)
      console.log('Running benchmark with warmed cache...')
    }

    // Run benchmark
    const result = await autocannon({
      url: proxyUrl,
      connections: 10,
      pipelining: 1,
      duration: 30,
      requests: DEFAULT_REQUESTS
    })

    console.log(formatResults(result, scenarioName))
    return result
  } finally {
    // Stop proxy server
    proxy.kill()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

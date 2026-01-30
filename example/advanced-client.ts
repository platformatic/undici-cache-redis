import { setTimeout as sleep } from 'node:timers/promises'
import { Agent, type Dispatcher, interceptors, setGlobalDispatcher } from 'undici'
import { type CacheStore, type CacheValueWithAdditionalProperties, createManager, createStore } from '../src/index.ts'

const API_BASE_URL = 'http://localhost:3000'

// Advanced cache store with custom configuration
async function createAdvancedCacheStore (): Promise<CacheStore> {
  const cacheStore = createStore({
    clientOpts: { host: 'localhost', port: 6379 },
    cacheTagsHeader: 'Cache-Tags',
    tracking: true,
    maxCount: 1000, // Larger tracking cache

    // Custom error handling with retry logic
    errorCallback: (err: Error & { code?: string }) => {
      console.error({ error: err.message, code: err.code }, 'Redis error')
      // Could implement circuit breaker pattern here
    }
  })

  return cacheStore
}

// Create advanced agent with caching
async function createAdvancedAgent (): Promise<{ agent: Dispatcher; cacheStore: CacheStore }> {
  const cacheStore = await createAdvancedCacheStore()

  const agent = new Agent().compose(interceptors.cache({ store: cacheStore, methods: ['GET'] }))

  // Set as global dispatcher for fetch
  setGlobalDispatcher(agent)

  return { agent, cacheStore }
}

// Demonstrate cache stampede protection
async function demonstrateCacheStampede (): Promise<void> {
  console.info('\n=== Cache Stampede Protection Demo ===\n')

  const { agent: sharedAgent, cacheStore } = await createAdvancedAgent()
  const cacheManager = createManager({
    clientOpts: { host: 'localhost', port: 6379 }
  })

  // Clear cache to start fresh
  const entriesToClear: string[] = []
  await cacheManager.streamEntries(entry => {
    entriesToClear.push(entry.id)
  }, '')
  if (entriesToClear.length > 0) {
    await cacheManager.deleteIds(entriesToClear, '')
  }

  console.info('Simulating 5 concurrent fetch requests for the same expensive resource...')

  // Make concurrent requests for expensive operation using fetch (which uses the shared agent)
  const startTime = Date.now()
  const promises = []

  for (let i = 0; i < 5; i++) {
    promises.push(
      fetch(`${API_BASE_URL}/api/stats`, {
        headers: { 'X-Client-ID': `client-${i}` }
      }).then(async response => {
        const data = await response.json()
        const duration = Date.now() - startTime
        console.info(
          {
            client: i,
            duration: duration + 'ms',
            cached: response.headers.get('x-cache-hit') === 'true' || response.headers.get('x-undici-cache') === 'hit'
          },
          `Fetch request ${i} completed`
        )
        return { client: i, duration, data }
      })
    )
  }

  await Promise.all(promises)

  console.info({
    totalTime: Date.now() - startTime + 'ms',
    message: 'All fetch requests completed. Only one should have hit the origin server.'
  })

  // Cleanup
  await sharedAgent.close()
  await cacheStore.close()
  await cacheManager.close()
}

// Demonstrate conditional caching based on response
async function demonstrateConditionalCaching (): Promise<void> {
  console.info('\n=== Conditional Caching Demo ===\n')

  const cacheStore = createStore({
    clientOpts: { host: 'localhost', port: 6379 }
  })

  const agent = new Agent().compose(interceptors.cache({ store: cacheStore, methods: ['GET'] }))

  // Test different scenarios
  console.info('Testing conditional caching scenarios...')

  // 1. Normal cacheable request
  const res1 = await agent.request({
    origin: API_BASE_URL,
    method: 'GET',
    path: '/api/products/1'
  })
  await res1.body.json()
  console.info('Request 1: Product detail - should be cached')

  // 2. Error response (404)
  try {
    const res2 = await agent.request({
      origin: API_BASE_URL,
      method: 'GET',
      path: '/api/products/999'
    })
    await res2.body.json()
  } catch (err) {
    // Expected
  }
  console.info('Request 2: 404 error - should NOT be cached')

  // 3. Personalized content
  const res3 = await agent.request({
    origin: API_BASE_URL,
    method: 'GET',
    path: '/api/recommendations/user123'
  })
  await res3.body.json()
  console.info('Request 3: Personalized recommendations - caching based on headers')

  // Check what was actually cached
  const cacheManager = createManager({ clientOpts: { host: 'localhost', port: 6379 } })
  let entryCount = 0
  await cacheManager.streamEntries(() => entryCount++, '')
  console.info({ cachedEntries: entryCount }, 'Cache statistics after conditional caching')

  // Cleanup
  await agent.close()
  await cacheStore.close()
  await cacheManager.close()
}

// Demonstrate cache warming and preloading
async function demonstrateCacheWarming (): Promise<void> {
  console.info('\n=== Cache Warming Demo ===\n')

  const cacheStore = await createAdvancedCacheStore()
  const agent = new Agent().compose(interceptors.cache({ store: cacheStore, methods: ['GET'] }))

  // URLs to warm up
  const urlsToWarm = [
    '/api/products',
    '/api/products/1',
    '/api/products/2',
    '/api/products/category/electronics',
    '/api/products/category/furniture',
    '/api/stats'
  ]

  console.info(`Warming cache with ${urlsToWarm.length} endpoints...`)

  const warmupStart = Date.now()
  const warmupPromises = urlsToWarm.map(async path => {
    const start = Date.now()
    const response = await agent.request({ origin: API_BASE_URL, method: 'GET', path })
    await response.body.json()
    return {
      path,
      duration: Date.now() - start,
      status: response.statusCode
    }
  })

  const warmupResults = await Promise.all(warmupPromises)
  const warmupDuration = Date.now() - warmupStart

  console.info(
    {
      totalDuration: warmupDuration + 'ms',
      endpoints: warmupResults
    },
    'Cache warming completed'
  )

  // Now make requests again to show cache benefits
  console.info('\nMaking requests again (should all be cache hits)...')

  const cachedStart = Date.now()
  for (const path of urlsToWarm) {
    const start = Date.now()
    const response = await agent.request({ origin: API_BASE_URL, method: 'GET', path })
    await response.body.json()
    console.info(
      {
        path,
        duration: Date.now() - start + 'ms',
        cached: true
      },
      'Cache hit'
    )
  }

  console.info(
    {
      warmupTime: warmupDuration + 'ms',
      cachedTime: Date.now() - cachedStart + 'ms',
      speedup: (warmupDuration / (Date.now() - cachedStart)).toFixed(1) + 'x'
    },
    'Cache warming performance summary'
  )

  // Cleanup
  await agent.close()
  await cacheStore.close()
}

// Demonstrate cache analytics and monitoring
async function demonstrateCacheAnalytics (): Promise<void> {
  console.info('\n=== Cache Analytics Demo ===\n')

  const cacheManager = createManager({
    clientOpts: { host: 'localhost', port: 6379 }
  })

  // Get detailed cache statistics
  let totalEntries = 0
  const tagAnalysis: Record<string, number> = {}
  const entries = []

  await cacheManager.streamEntries(entry => {
    totalEntries++
    entries.push(entry)
    for (const tag of entry.tags) {
      tagAnalysis[tag] = (tagAnalysis[tag] || 0) + 1
    }
  }, '')

  console.info(
    {
      totalEntries,
      avgTagsPerEntry: totalEntries > 0 ? Object.values(tagAnalysis).reduce((a, b) => a + b, 0) / totalEntries : 0
    },
    'Cache overview'
  )

  console.info({ tagDistribution: tagAnalysis }, 'Cache entries by tag')

  // Sample some cache entries for analysis
  const sampleEntries: (Partial<CacheValueWithAdditionalProperties> & { age: number })[] = []
  await cacheManager.streamEntries(entry => {
    if (sampleEntries.length < 10) {
      sampleEntries.push({
        id: entry.id,
        path: entry.path,
        tags: entry.tags,
        statusCode: entry.statusCode,
        age: Date.now() - entry.cachedAt
      })
    }
  }, '')

  if (sampleEntries.length > 0) {
    console.info({ entries: sampleEntries }, 'Sample cache entries')
  }

  await cacheManager.close()
}

// Main demonstration
async function runAdvancedDemo (): Promise<void> {
  try {
    // Ensure server is running
    const healthCheck = await fetch(`${API_BASE_URL}/health`).catch(() => null)
    if (!healthCheck || !healthCheck.ok) {
      console.error('API server is not running. Please start the server first.')
      process.exit(1)
    }

    // Run demonstrations
    await demonstrateCacheStampede()
    await sleep(1000)

    await demonstrateConditionalCaching()
    await sleep(1000)

    await demonstrateCacheWarming()
    await sleep(1000)

    await demonstrateCacheAnalytics()

    console.info('\n=== Advanced demonstration completed! ===')
  } catch (error) {
    console.error({ error: (error as Error).message }, 'Advanced demo failed')
    process.exit(1)
  }
}

// Run the advanced demonstration
runAdvancedDemo()

'use strict'

const { Agent, Client, interceptors, setGlobalDispatcher } = require('undici')
const { RedisCacheStore, RedisCacheManager } = require('../index.js')
const pino = require('pino')
const { promisify } = require('util')

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss'
    }
  }
})

const sleep = promisify(setTimeout)
const API_BASE_URL = 'http://localhost:3000'

// Advanced cache store with custom configuration
async function createAdvancedCacheStore () {
  const cacheStore = new RedisCacheStore({
    redis: 'redis://localhost:6379',
    ttl: 3600 * 1000, // 1 hour
    tbd: 300 * 1000,  // 5 minutes stale time
    cacheTagsHeader: 'Cache-Tags',
    tracking: true,
    trackingCacheSize: 1000, // Larger tracking cache

    // Custom error handling with retry logic
    errorCallback: (err) => {
      logger.error({ error: err.message, code: err.code }, 'Redis error')
      // Could implement circuit breaker pattern here
    },

    // Custom key generation for more control
    keyGenerator: (request) => {
      const { origin, path, method } = request
      // Could add user ID, API version, etc.
      return `${method}:${origin}${path}`.toLowerCase()
    }
  })

  return cacheStore
}

// Create advanced agent with caching
async function createAdvancedAgent () {
  const cacheStore = await createAdvancedCacheStore()

  const agent = new Agent({
    interceptors: {
      Agent: [interceptors.cache({ store: cacheStore, methods: ['GET'] })]
    }
  })

  // Set as global dispatcher for fetch
  setGlobalDispatcher(agent)

  return { agent, cacheStore }
}

// Demonstrate cache stampede protection
async function demonstrateCacheStampede () {
  logger.info('\n=== Cache Stampede Protection Demo ===\n')

  const { agent: sharedAgent, cacheStore } = await createAdvancedAgent()
  const cacheManager = new RedisCacheManager({
    redis: 'redis://localhost:6379'
  })

  // Clear cache to start fresh
  await cacheManager.clear()

  logger.info('Simulating 5 concurrent fetch requests for the same expensive resource...')

  // Make concurrent requests for expensive operation using fetch (which uses the shared agent)
  const startTime = Date.now()
  const promises = []

  for (let i = 0; i < 5; i++) {
    promises.push(
      fetch(`${API_BASE_URL}/api/stats`, {
        headers: { 'X-Client-ID': `client-${i}` }
      }).then(async (response) => {
        const data = await response.json()
        const duration = Date.now() - startTime
        logger.info({
          client: i,
          duration: duration + 'ms',
          cached: response.headers.get('x-cache-hit') === 'true' || response.headers.get('x-undici-cache') === 'hit'
        }, `Fetch request ${i} completed`)
        return { client: i, duration, data }
      })
    )
  }

  await Promise.all(promises)

  logger.info({
    totalTime: Date.now() - startTime + 'ms',
    message: 'All fetch requests completed. Only one should have hit the origin server.'
  })

  // Cleanup
  await sharedAgent.close()
  await cacheStore.close()
  await cacheManager.close()
}

// Demonstrate conditional caching based on response
async function demonstrateConditionalCaching () {
  logger.info('\n=== Conditional Caching Demo ===\n')

  const cacheStore = new RedisCacheStore({
    redis: 'redis://localhost:6379',
    ttl: 3600 * 1000,

    // Custom cache decision logic
    shouldCache: (request, response) => {
      // Don't cache errors
      if (response.statusCode >= 400) return false

      // Don't cache if response has no-store directive
      const cacheControl = response.headers['cache-control']
      if (cacheControl && cacheControl.includes('no-store')) return false

      // Don't cache personalized content
      if (response.headers['x-personalized'] === 'true') return false

      // Cache everything else
      return true
    }
  })

  const client = new Client(API_BASE_URL, {
    interceptors: {
      Client: [interceptors.cache({ store: cacheStore, methods: ['GET'] })]
    }
  })

  // Test different scenarios
  logger.info('Testing conditional caching scenarios...')

  // 1. Normal cacheable request
  const res1 = await client.request({
    method: 'GET',
    path: '/api/products/1'
  })
  await res1.body.json()
  logger.info('Request 1: Product detail - should be cached')

  // 2. Error response (404)
  try {
    const res2 = await client.request({
      method: 'GET',
      path: '/api/products/999'
    })
    await res2.body.json()
  } catch (err) {
    // Expected
  }
  logger.info('Request 2: 404 error - should NOT be cached')

  // 3. Personalized content
  const res3 = await client.request({
    method: 'GET',
    path: '/api/recommendations/user123'
  })
  await res3.body.json()
  logger.info('Request 3: Personalized recommendations - caching based on headers')

  // Check what was actually cached
  const cacheManager = new RedisCacheManager({ redis: 'redis://localhost:6379' })
  const stats = await cacheManager.getStats()
  logger.info({ cachedEntries: stats.entries }, 'Cache statistics after conditional caching')

  // Cleanup
  await client.close()
  await cacheStore.close()
  await cacheManager.close()
}

// Demonstrate cache warming and preloading
async function demonstrateCacheWarming () {
  logger.info('\n=== Cache Warming Demo ===\n')

  const cacheStore = await createAdvancedCacheStore()
  const client = new Client(API_BASE_URL, {
    interceptors: {
      Client: [interceptors.cache({ store: cacheStore, methods: ['GET'] })]
    }
  })

  // URLs to warm up
  const urlsToWarm = [
    '/api/products',
    '/api/products/1',
    '/api/products/2',
    '/api/products/category/electronics',
    '/api/products/category/furniture',
    '/api/stats'
  ]

  logger.info(`Warming cache with ${urlsToWarm.length} endpoints...`)

  const warmupStart = Date.now()
  const warmupPromises = urlsToWarm.map(async (path) => {
    const start = Date.now()
    const response = await client.request({ method: 'GET', path })
    await response.body.json()
    return {
      path,
      duration: Date.now() - start,
      status: response.statusCode
    }
  })

  const warmupResults = await Promise.all(warmupPromises)
  const warmupDuration = Date.now() - warmupStart

  logger.info({
    totalDuration: warmupDuration + 'ms',
    endpoints: warmupResults
  }, 'Cache warming completed')

  // Now make requests again to show cache benefits
  logger.info('\nMaking requests again (should all be cache hits)...')

  const cachedStart = Date.now()
  for (const path of urlsToWarm) {
    const start = Date.now()
    const response = await client.request({ method: 'GET', path })
    await response.body.json()
    logger.info({
      path,
      duration: (Date.now() - start) + 'ms',
      cached: true
    }, 'Cache hit')
  }

  logger.info({
    warmupTime: warmupDuration + 'ms',
    cachedTime: (Date.now() - cachedStart) + 'ms',
    speedup: (warmupDuration / (Date.now() - cachedStart)).toFixed(1) + 'x'
  }, 'Cache warming performance summary')

  // Cleanup
  await client.close()
  await cacheStore.close()
}

// Demonstrate cache analytics and monitoring
async function demonstrateCacheAnalytics () {
  logger.info('\n=== Cache Analytics Demo ===\n')

  const cacheManager = new RedisCacheManager({
    redis: 'redis://localhost:6379'
  })

  // Get detailed cache statistics
  const stats = await cacheManager.getStats()
  logger.info({
    totalEntries: stats.entries,
    totalSize: stats.size,
    avgEntrySize: stats.entries > 0 ? Math.round(stats.size / stats.entries) : 0
  }, 'Cache overview')

  // Analyze cache entries by tag
  const tagAnalysis = {}
  const entries = await cacheManager.list({ limit: 100 })

  for (const entry of entries) {
    const tags = entry.metadata?.tags || []
    for (const tag of tags) {
      tagAnalysis[tag] = (tagAnalysis[tag] || 0) + 1
    }
  }

  logger.info({ tagDistribution: tagAnalysis }, 'Cache entries by tag')

  // Find large cache entries
  const largeEntries = entries
    .filter(e => e.size > 10000)
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map(e => ({
      key: e.key,
      size: e.size,
      tags: e.metadata?.tags,
      age: Date.now() - new Date(e.metadata?.cachedAt).getTime()
    }))

  if (largeEntries.length > 0) {
    logger.info({ entries: largeEntries }, 'Largest cache entries')
  }

  // Find soon-to-expire entries
  const expiringEntries = entries
    .filter(e => e.ttl > 0 && e.ttl < 60000) // Expiring in next minute
    .map(e => ({
      key: e.key,
      ttl: Math.round(e.ttl / 1000) + 's',
      tags: e.metadata?.tags
    }))

  if (expiringEntries.length > 0) {
    logger.info({ entries: expiringEntries }, 'Entries expiring soon')
  }

  await cacheManager.close()
}

// Main demonstration
async function runAdvancedDemo () {
  try {
    // Ensure server is running
    const healthCheck = await fetch(`${API_BASE_URL}/health`).catch(() => null)
    if (!healthCheck || !healthCheck.ok) {
      logger.error('API server is not running. Please start the server first.')
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

    logger.info('\n=== Advanced demonstration completed! ===')
  } catch (error) {
    logger.error({ error: error.message }, 'Advanced demo failed')
    process.exit(1)
  }
}

// Run the advanced demonstration
runAdvancedDemo()

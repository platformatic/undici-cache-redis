'use strict'

const { Agent, interceptors, setGlobalDispatcher } = require('undici')
const { RedisCacheStore, RedisCacheManager } = require('../index.js')

const API_BASE_URL = 'http://localhost:3000'

// Performance tracking
class PerformanceTracker {
  constructor () {
    this.requests = []
  }

  startRequest (url, fromCache = false) {
    const id = Date.now() + Math.random()
    const request = {
      id,
      url,
      startTime: process.hrtime.bigint(),
      fromCache
    }
    this.requests.push(request)
    return id
  }

  endRequest (id) {
    const request = this.requests.find(r => r.id === id)
    if (request) {
      request.endTime = process.hrtime.bigint()
      request.duration = Number(request.endTime - request.startTime) / 1000000 // Convert to ms
      return request
    }
  }

  getStats () {
    const completed = this.requests.filter(r => r.endTime)
    const cached = completed.filter(r => r.fromCache)
    const uncached = completed.filter(r => !r.fromCache)

    return {
      total: completed.length,
      cached: cached.length,
      uncached: uncached.length,
      avgDuration: completed.reduce((sum, r) => sum + r.duration, 0) / completed.length || 0,
      avgCachedDuration: cached.reduce((sum, r) => sum + r.duration, 0) / cached.length || 0,
      avgUncachedDuration: uncached.reduce((sum, r) => sum + r.duration, 0) / uncached.length || 0,
      cacheHitRate: (cached.length / completed.length * 100) || 0
    }
  }
}

const tracker = new PerformanceTracker()

async function createCachedAgent () {
  // Create Redis cache store with configuration
  const cacheStore = new RedisCacheStore({
    clientOpts: { host: 'localhost', port: 6379 },
    cacheTagsHeader: 'Cache-Tags', // Header name for cache tags
    tracking: true, // Enable client-side tracking for performance
    maxCount: 100, // LRU cache size
    errorCallback: (err) => {
      console.error('Redis cache error:', err.message)
    }
  })

  // Create cache manager for administrative operations
  const cacheManager = new RedisCacheManager({
    clientOpts: { host: 'localhost', port: 6379 }
  })

  // Create Undici agent with cache interceptor
  const agent = new Agent()
    .compose(interceptors.cache({
      store: cacheStore,
      methods: ['GET'] // Only cache GET requests
    }))

  // Set as global dispatcher to work with fetch
  setGlobalDispatcher(agent)

  return { agent, cacheStore, cacheManager }
}

async function makeRequestWithAgent (agent, method, path, body = null) {
  try {
    const requestId = tracker.startRequest(`${method} ${path}`)

    const options = {
      method,
      path,
      origin: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json'
      }
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await agent.request(options)
    const data = await response.body.json()

    // Check if response came from cache
    const fromCache = response.headers['x-cache-hit'] === 'true' ||
                     response.headers['x-undici-cache'] === 'hit'

    const perfData = tracker.endRequest(requestId)
    if (perfData) {
      perfData.fromCache = fromCache
      console.info({
        method,
        path,
        duration: perfData.duration.toFixed(2) + 'ms',
        cache: fromCache ? 'HIT' : 'MISS'
      }, fromCache ? 'Cache HIT' : 'Cache MISS')
    }

    return { status: response.statusCode, data }
  } catch (error) {
    console.error({ method, path, error: error.message }, 'Agent request failed')
    throw error
  }
}

async function makeRequestWithFetch (method, path, body = null) {
  try {
    const requestId = tracker.startRequest(`${method} ${path}`)

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(`${API_BASE_URL}${path}`, options)
    const data = await response.json()

    // Check if response came from cache (fetch with undici agent)
    const fromCache = response.headers.get('x-cache-hit') === 'true' ||
                     response.headers.get('x-undici-cache') === 'hit'

    const perfData = tracker.endRequest(requestId)
    if (perfData) {
      perfData.fromCache = fromCache
      console.info({
        method,
        path,
        duration: perfData.duration.toFixed(2) + 'ms',
        cache: fromCache ? 'HIT' : 'MISS'
      }, fromCache ? 'Cache HIT (fetch)' : 'Cache MISS (fetch)')
    }

    return { status: response.status, data }
  } catch (error) {
    console.error({ method, path, error: error.message }, 'Fetch request failed')
    throw error
  }
}

async function demonstrateCaching () {
  console.info('Starting Undici Redis Cache demonstration...')

  const { agent, cacheStore, cacheManager } = await createCachedAgent()

  try {
    console.info('\n--- Phase 1: Initial requests using agent.request() (cache misses) ---')

    // Make initial requests that will be cached using agent.request
    await makeRequestWithAgent(agent, 'GET', '/api/products')
    await makeRequestWithAgent(agent, 'GET', '/api/products/1')
    await makeRequestWithAgent(agent, 'GET', '/api/products/category/electronics')
    await makeRequestWithAgent(agent, 'GET', '/api/stats')
    await makeRequestWithAgent(agent, 'GET', '/api/recommendations/user123')

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100))

    console.info('\n--- Phase 2: Repeated requests using fetch() (cache hits) ---')

    // Make the same requests again using fetch - should be served from cache
    await makeRequestWithFetch('GET', '/api/products')
    await makeRequestWithFetch('GET', '/api/products/1')
    await makeRequestWithFetch('GET', '/api/products/category/electronics')
    await makeRequestWithFetch('GET', '/api/stats')

    // Different user ID - will be a cache miss
    await makeRequestWithFetch('GET', '/api/recommendations/user456')

    console.info('\n--- Phase 3: Cache invalidation by tags ---')

    // Count current cache entries
    let entryCount = 0
    await cacheManager.streamEntries(() => entryCount++, '')
    console.info({ totalEntries: entryCount }, 'Cache entries before invalidation')

    // Invalidate all product-related caches using the store
    await cacheStore.deleteTags(['products'])
    console.info('Invalidated entries by tag "products"')

    // Make request again - should be cache miss after invalidation
    console.info('\nRequests after cache invalidation using agent:')
    await makeRequestWithAgent(agent, 'GET', '/api/products')
    await makeRequestWithAgent(agent, 'GET', '/api/products/1')

    // Stats should still be cached
    await makeRequestWithFetch('GET', '/api/stats')

    console.info('\n--- Phase 4: Update product and automatic invalidation ---')

    // Update a product (server will send cache invalidation hints)
    await makeRequestWithFetch('PUT', '/api/products/1', {
      price: 1199.99,
      stock: 45
    })

    // Try to get the product again - should reflect the update
    const { data: updatedProduct } = await makeRequestWithAgent(agent, 'GET', '/api/products/1')
    console.info({ product: updatedProduct.product }, 'Updated product data')

    console.info('\n--- Phase 5: Performance comparison ---')

    // Clear all cache for fair comparison by deleting all entries
    const entriesToDelete = []
    await cacheManager.streamEntries((entry) => {
      entriesToDelete.push(entry.id)
    }, '')
    if (entriesToDelete.length > 0) {
      await cacheManager.deleteIds(entriesToDelete, '')
    }
    tracker.requests = [] // Reset tracker

    // Make 10 requests without cache benefit using agent
    console.info('\nMaking 10 sequential requests with agent (first run - no cache):')
    for (let i = 1; i <= 5; i++) {
      await makeRequestWithAgent(agent, 'GET', `/api/products/${i}`)
      await makeRequestWithAgent(agent, 'GET', `/api/products/category/${i % 2 === 0 ? 'electronics' : 'furniture'}`)
    }

    const statsNoCacheEnd = tracker.getStats()

    // Make the same requests again with cache using fetch
    console.info('\nMaking the same 10 requests with fetch (with cache):')
    for (let i = 1; i <= 5; i++) {
      await makeRequestWithFetch('GET', `/api/products/${i}`)
      await makeRequestWithFetch('GET', `/api/products/category/${i % 2 === 0 ? 'electronics' : 'furniture'}`)
    }

    const statsFinal = tracker.getStats()

    console.info('\n--- Final Performance Summary ---')
    console.info({
      firstRun: {
        avgDuration: statsNoCacheEnd.avgUncachedDuration.toFixed(2) + 'ms',
        requests: 10
      },
      secondRun: {
        avgDuration: (statsFinal.avgCachedDuration || statsFinal.avgDuration).toFixed(2) + 'ms',
        cacheHitRate: ((statsFinal.cached - statsNoCacheEnd.cached) / 10 * 100).toFixed(1) + '%'
      },
      improvement: {
        speedup: (statsNoCacheEnd.avgUncachedDuration / (statsFinal.avgCachedDuration || 1)).toFixed(1) + 'x',
        timeSaved: (statsNoCacheEnd.avgUncachedDuration - (statsFinal.avgCachedDuration || 0)).toFixed(2) + 'ms per request'
      }
    }, 'Performance improvement with caching')

    // Get final cache statistics
    let finalEntryCount = 0
    const sampleEntries = []
    await cacheManager.streamEntries((entry) => {
      finalEntryCount++
      if (sampleEntries.length < 5) {
        sampleEntries.push({
          id: entry.id,
          path: entry.path,
          tags: entry.cacheTags,
          statusCode: entry.statusCode
        })
      }
    }, '')
    console.info({ totalEntries: finalEntryCount }, 'Final cache statistics')
    console.info({ entries: sampleEntries }, 'Sample cache entries')
  } catch (error) {
    console.error({ error: error.message }, 'Demonstration failed')
  } finally {
    // Cleanup
    await agent.close()
    await cacheStore.close()
    await cacheManager.close()
  }
}

// Run the demonstration
demonstrateCaching().then(() => {
  console.info('Demonstration completed successfully!')
  process.exit(0)
}).catch((err) => {
  console.error({ error: err }, 'Demonstration failed')
  process.exit(1)
})

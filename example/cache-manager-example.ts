import { Agent, interceptors, setGlobalDispatcher } from 'undici'
import { type CacheValue, createManager, createStore } from '../src/index.ts'

interface CacheAnalysis {
  totalEntries: number
  byStatusCode: Map<number, number>
  byPath: Map<string, number>
  oldestEntry: CacheValue | null
  newestEntry: CacheValue | null
}

const API_BASE_URL = 'http://localhost:3000'

// Demonstrate advanced cache management with RedisCacheManager
async function demonstrateCacheManagement (): Promise<void> {
  console.info('🚀 Redis Cache Management Demo\n')

  // Create cache store and manager
  const cacheStore = createStore({
    clientOpts: { host: 'localhost', port: 6379 },
    cacheTagsHeader: 'Cache-Tags',
    tracking: true
  })

  const cacheManager = createManager({
    clientOpts: { host: 'localhost', port: 6379 }
  })

  // Create agent with caching
  const agent = new Agent().compose(interceptors.cache({ store: cacheStore }))

  setGlobalDispatcher(agent)

  try {
    console.info('--- Step 1: Populate cache with tagged entries ---\n')

    // Make requests to populate cache
    await fetch(`${API_BASE_URL}/api/products`)
    await fetch(`${API_BASE_URL}/api/products/1`)
    await fetch(`${API_BASE_URL}/api/products/2`)
    await fetch(`${API_BASE_URL}/api/products/category/electronics`)
    await fetch(`${API_BASE_URL}/api/stats`)

    // Show current cache state
    let totalEntries = 0
    const entriesByTag = new Map()

    await cacheManager.streamEntries(entry => {
      totalEntries++
      console.info(`  📄 ${entry.path} (tags: [${entry.tags.join(', ')}])`)

      // Group entries by tags
      for (const tag of entry.tags) {
        if (!entriesByTag.has(tag)) {
          entriesByTag.set(tag, [])
        }
        entriesByTag.get(tag).push(entry.path)
      }
    }, '')

    console.info(`\n📊 Total entries: ${totalEntries}`)
    console.info('📋 Entries by tag:')
    for (const [tag, paths] of entriesByTag.entries()) {
      console.info(`  🏷️  ${tag}: ${paths.length} entries`)
      for (const path of paths) {
        console.info(`     - ${path}`)
      }
    }

    console.info('\n--- Step 2: Subscribe to cache events ---\n')

    // Subscribe to cache manager events
    await cacheManager.subscribe()

    cacheManager.on('add-entry', entry => {
      console.info(`✅ Cache entry added: ${entry.path} [${entry.cacheTags.join(', ')}]`)
    })

    cacheManager.on('delete-entry', ({ id, keyPrefix }) => {
      console.info(`❌ Cache entry deleted: ${id}`)
    })

    cacheManager.on('error', err => {
      console.error(`🚨 Cache manager error: ${err.message}`)
    })

    // Make a new request to trigger add-entry event
    console.info('Making new request to trigger cache events...')
    await fetch(`${API_BASE_URL}/api/products/3`)

    // Wait for events to be processed
    await new Promise(resolve => setTimeout(resolve, 100))

    console.info('\n--- Step 3: Cache invalidation by tags ---\n')

    console.info('Before invalidation:')
    let beforeCount = 0
    await cacheManager.streamEntries(() => beforeCount++, '')
    console.info(`📊 Total entries: ${beforeCount}`)

    // Method 1: Use RedisCacheStore to invalidate by tags
    console.info('\n🧹 Invalidating all "products" tagged entries...')
    await cacheStore.deleteTags(['products'])

    // Wait for events to be processed
    await new Promise(resolve => setTimeout(resolve, 100))

    console.info('\nAfter "products" tag invalidation:')
    let afterCount = 0
    const remainingEntries: string[] = []
    await cacheManager.streamEntries(entry => {
      afterCount++
      remainingEntries.push(`${entry.path} [${entry.tags.join(', ')}]`)
    }, '')
    console.info(`📊 Total entries: ${afterCount}`)
    console.info('📋 Remaining entries:')
    for (const entry of remainingEntries) {
      console.info(`  📄 ${entry}`)
    }

    console.info('\n--- Step 4: Advanced cache analysis ---\n')

    // Repopulate cache for analysis
    await fetch(`${API_BASE_URL}/api/products`)
    await fetch(`${API_BASE_URL}/api/products/1`)
    await fetch(`${API_BASE_URL}/api/recommendations/user123`)

    // Wait for cache to be populated
    await new Promise(resolve => setTimeout(resolve, 100))

    // Analyze cache entries
    const analysis: CacheAnalysis = {
      totalEntries: 0,
      byStatusCode: new Map(),
      byPath: new Map(),
      oldestEntry: null,
      newestEntry: null
    }

    await cacheManager.streamEntries(entry => {
      analysis.totalEntries++

      // Group by status code
      const statusCount = analysis.byStatusCode.get(entry.statusCode) || 0
      analysis.byStatusCode.set(entry.statusCode, statusCount + 1)

      // Track by path pattern
      const pathPattern = entry.path.replace(/\/\d+/, '/:id')
      const pathCount = analysis.byPath.get(pathPattern) || 0
      analysis.byPath.set(pathPattern, pathCount + 1)

      // Find oldest/newest
      if (!analysis.oldestEntry || entry.cachedAt < analysis.oldestEntry.cachedAt) {
        analysis.oldestEntry = entry
      }
      if (!analysis.newestEntry || entry.cachedAt > analysis.newestEntry.cachedAt) {
        analysis.newestEntry = entry
      }
    }, '')

    console.info('📈 Cache Analysis:')
    console.info(`  📊 Total entries: ${analysis.totalEntries}`)
    console.info('  📊 By status code:')
    for (const [status, count] of analysis.byStatusCode.entries()) {
      console.info(`     ${status}: ${count} entries`)
    }
    console.info('  📊 By path pattern:')
    for (const [pattern, count] of analysis.byPath.entries()) {
      console.info(`     ${pattern}: ${count} entries`)
    }
    if (analysis.oldestEntry && analysis.newestEntry) {
      const ageMs = analysis.newestEntry.cachedAt - analysis.oldestEntry.cachedAt
      console.info(`  ⏰ Cache age spread: ${ageMs}ms`)
    }

    console.info('\n--- Step 5: Selective cache cleanup ---\n')

    // Find entries with specific characteristics
    const entriesToDelete: string[] = []

    await cacheManager.streamEntries(entry => {
      // Delete product detail entries (but keep category listings)
      if (entry.path.match(/^\/api\/products\/\d+$/)) {
        entriesToDelete.push(entry.id)
      }
    }, '')

    if (entriesToDelete.length > 0) {
      console.info(`🧹 Deleting ${entriesToDelete.length} product detail entries...`)
      await cacheManager.deleteIds(entriesToDelete, '')

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Show final state
    console.info('\nFinal cache state:')
    let finalCount = 0
    await cacheManager.streamEntries(entry => {
      finalCount++
      console.info(`  📄 ${entry.path} [${entry.tags.join(', ')}]`)
    }, '')
    console.info(`📊 Final total entries: ${finalCount}`)

    console.info('\n--- Step 6: Get cache entry details ---\n')

    // Demonstrate getting response body by ID
    let sampleEntryId: string | null = null
    await cacheManager.streamEntries(entry => {
      if (!sampleEntryId && entry.path === '/api/products') {
        sampleEntryId = entry.id
      }
    }, '')

    if (sampleEntryId) {
      console.info(`🔍 Getting response body for entry: ${sampleEntryId}`)
      const responseBody = await cacheManager.getResponseById(sampleEntryId, '')
      if (responseBody) {
        const data = JSON.parse(responseBody)
        console.info('📦 Response preview:', {
          productsCount: data.products?.length || 'N/A',
          firstProduct: data.products?.[0]?.name || 'N/A'
        })
      }
    }

    console.info('\n✅ Cache management demonstration completed!')
  } catch (error) {
    console.error('❌ Demonstration failed:', (error as Error).message)
  } finally {
    // Cleanup
    await agent.close()
    await cacheStore.close()
    await cacheManager.close()
  }
}

// Check if server is running before starting demo
async function main () {
  try {
    const healthCheck = await fetch(`${API_BASE_URL}/health`).catch(() => null)
    if (!healthCheck || !healthCheck.ok) {
      console.error('❌ API server is not running. Please start the server first.')
      console.info('Run: node server.ts')
      process.exit(1)
    }

    await demonstrateCacheManagement()
  } catch (error) {
    console.error('❌ Demo failed:', (error as Error).message)
    process.exit(1)
  }
}

main()

export {
  RedisCacheStore,
  RedisCacheManager,
  RedisCacheStoreOpts,
  RedisCacheManagerOpts,
  CacheEntry
} from './src/v1'

export {
  RedisCache,
  RedisCacheOpts,
  RedisCacheEntry,
  RedisCacheFilter
} from './src/v2'

export { default } from './src/v2'

export { GetResult, CacheKey, CachedResponse } from './src/common/internal-types'

import { RedisCacheStore, RedisCacheManager, RedisCacheStoreOpts, RedisCacheManagerOpts } from './src/v1'
import { RedisCache, RedisCacheOpts } from './src/v2'

export function createStore(opts?: RedisCacheOpts): RedisCache
export function createStore(opts: RedisCacheStoreOpts | undefined, version: '1.0.0' | '1'): RedisCacheStore
export function createManager(opts?: RedisCacheOpts): RedisCache
export function createManager(opts: RedisCacheManagerOpts | undefined, version: '1.0.0' | '1'): RedisCacheManager

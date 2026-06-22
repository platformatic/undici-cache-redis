import RedisCache from './src/v2/cache.js'
import { RedisCacheManager, RedisCacheStore } from './src/v1/redis-cache-store.js'

export function createStore (opts, version) {
  if (version === '1.0.0' || version === '1') {
    return new RedisCacheStore(opts)
  }

  return new RedisCache(opts)
}

export function createManager (opts, version) {
  if (version === '1.0.0' || version === '1') {
    return new RedisCacheManager(opts)
  }

  return new RedisCache(opts)
}

export { RedisCache, RedisCacheManager, RedisCacheStore }
export default RedisCache

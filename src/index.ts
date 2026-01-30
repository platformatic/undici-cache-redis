import type { CacheManager, CacheManagerOptions, CacheStore, CacheStoreOptions } from './types.ts'
import * as v1 from './v1/index.ts'
import * as v2 from './v2/index.ts'

export * from './types.ts'
export * from './utils.ts'
export * as v1 from './v1/index.ts'
export * as v2 from './v2/index.ts'

export const defaultVersion = '2.0.0'

export function createStore (options?: Partial<CacheStoreOptions>, version?: string): CacheStore {
  options ??= {}
  return version === '1.0.0' ? new v1.RedisCacheStore(options) : new v2.Cache(options)
}

export function createManager (options?: Partial<CacheManagerOptions>, version?: string): CacheManager {
  options ??= {}
  return version === '1.0.0' ? new v1.RedisCacheManager(options) : new v2.Cache(options)
}

import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { RedisOptions } from 'iovalkey'
import { GetResult, CacheKey, CachedResponse } from '../common/internal-types'

export interface RedisCacheStoreOpts {
  clientConfigTracking?: boolean
  clientOpts?: RedisOptions
  maxEntrySize?: number
  maxSize?: number
  maxCount?: number
  tracking?: boolean
  cacheTagsHeader?: string
  errorCallback?: (err: Error) => void
}

export interface RedisCacheManagerOpts {
  clientConfigKeyspaceEventNotify?: boolean
  clientOpts?: RedisOptions
}

export declare class RedisCacheStore extends EventEmitter {
  constructor(opts?: RedisCacheStoreOpts)

  get(key: CacheKey): Promise<GetResult | undefined>

  createWriteStream(key: CacheKey, value: CachedResponse): Writable

  delete(key: CacheKey): Promise<void>

  deleteKeys(keys: CacheKey[]): Promise<void>

  deleteTags(tags: string[]): Promise<void>

  close(): Promise<void>
}

export interface CacheEntry {
  id: string
  keyPrefix: string
  origin: string
  path: string
  method: string
  statusCode: number
  headers: Record<string, string | string[]>
  cacheTags: string[]
  cachedAt: number
  staleAt: number
  deleteAt: number
}

export declare class RedisCacheManager extends EventEmitter {
  constructor(opts?: RedisCacheManagerOpts)

  streamEntries(callback: (entry: CacheEntry) => Promise<unknown> | unknown, keyPrefix: string): Promise<void>

  subscribe(): Promise<void>

  getResponseById(id: string, keyPrefix: string): Promise<string | null>

  getDependentEntries(id: string, keyPrefix: string): Promise<CacheEntry[]>

  deleteIds(ids: string[], keyPrefix: string): Promise<void>

  close(): Promise<void>
}

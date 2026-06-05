import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { RedisOptions } from 'iovalkey'
import { GetResult, CacheKey, CachedResponse } from '../common/internal-types'

export interface RedisCacheOpts {
  prefix?: string
  clusterId?: string
  clientConfigTracking?: boolean
  clientConfigKeyspaceEventNotify?: boolean
  clientOpts?: RedisOptions
  maxEntrySize?: number
  maxSize?: number
  maxCount?: number
  maxBatchSize?: number
  concurrency?: number
  tracking?: boolean
  cacheTagsHeader?: string
  errorCallback?: (err: Error) => void
}

export interface RedisCacheEntry {
  id: string
  prefix: string
  origin: string
  path: string
  method: string
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
  tags: string[]
  cacheTags: string[]
  cachedAt: number
  staleAt: number
  deleteAt: number
  cacheControlDirectives: Record<string, string | string[]>
}

export interface RedisCacheFilter {
  id?: string
  origin?: string
  method?: string
  path?: string
}

export declare class RedisCache extends EventEmitter {
  constructor(opts?: RedisCacheOpts)

  readonly version: string

  readonly dataVersion: string

  readonly prefix: string

  readonly clusterId?: string

  get(key: CacheKey, prefixes?: string | string[]): Promise<GetResult | undefined>

  get(key: CacheKey, prefixes: string | string[] | undefined, includeBody: false): Promise<CachedResponse | undefined>

  getKeys(keys: Iterable<CacheKey>, prefixes?: string | string[]): Promise<GetResult[]>

  createWriteStream(key: CacheKey, value: CachedResponse): Writable

  delete(key: CacheKey, prefixes?: string | string[]): Promise<void>

  deleteKeys(keys: Iterable<CacheKey>, prefixes?: string | string[]): Promise<void>

  deleteIds(ids: string[], prefixes?: string | string[]): Promise<void>

  deleteTag(tags: string | string[], prefixes?: string | string[]): Promise<void>

  deleteTags(tags: Array<string | string[]>, prefixes?: string | string[]): Promise<void>

  entries(filter?: RedisCacheFilter, prefixes?: string | string[]): Promise<RedisCacheEntry[]>

  deleteEntries(filter?: RedisCacheFilter, prefixes?: string | string[]): Promise<RedisCacheEntry[]>

  getTag(tag: string, prefixes?: string | string[]): Promise<RedisCacheEntry[]>

  getTags(tags: Array<string | string[]>, prefixes?: string | string[]): Promise<RedisCacheEntry[]>

  streamEntries(callback: (entry: RedisCacheEntry) => Promise<unknown> | unknown, prefixes?: string | string[]): Promise<void>

  subscribe(prefixes?: string | string[]): Promise<void>

  getResponseById(id: string, prefixes?: string | string[]): Promise<string | null>

  getDependentEntries(id: string, prefixes?: string | string[]): Promise<RedisCacheEntry[]>

  close(): Promise<void>
}

export default RedisCache

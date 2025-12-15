import { type Redis, type RedisOptions } from 'iovalkey'
import { type EventEmitter, type Readable } from 'node:stream'
import type CacheHandler from 'undici/types/cache-interceptor.d.ts'

export interface CacheKey extends CacheHandler.default.CacheKey {
  id?: string
}

export interface CacheEntry extends CacheHandler.default.CacheValue {
  id: string
  keyPrefix: string
  origin: string
  method: string
  path: string
  cacheTags: string[]
}

export interface CacheEntryWithBody extends CacheEntry {
  cacheControlDirectives: CacheHandler.default.CacheControlDirectives
  body: undefined | Readable | Iterable<Buffer> | Buffer | Iterable<string> | string
}

export interface CacheStoreOptions {
  prefix?: string
  clientConfigTracking?: boolean
  clientOpts?: Omit<RedisOptions, 'keyPrefix'>
  maxEntrySize?: number
  maxSize?: number
  maxCount?: number
  tracking?: boolean
  cacheTagsHeader?: string
  errorCallback?: (err: Error) => void
}

export interface CacheManagerOptions extends CacheStoreOptions {
  clientConfigKeyspaceEventNotify?: boolean
  // New in v2
  maxBatchSize?: number
  concurrency?: number
}

export interface CacheStore extends CacheHandler.default.CacheStore, EventEmitter {
  version: string
  client: Redis

  get (key: CacheKey): Promise<CacheEntryWithBody | undefined>
  deleteKeys (keys: CacheKey[]): Promise<void>
  deleteTags (tags: Array<string | string[]>): Promise<void>
  close (): Promise<void>
}

export interface CacheManager extends EventEmitter {
  version: string
  client: Redis

  streamEntries (
    callback: (entry: CacheEntry) => Promise<unknown> | unknown,
    keyPrefix: string | string[]
  ): Promise<void>
  subscribe (): Promise<void>
  getResponseById (id: string, keyPrefix: string): Promise<string | null>
  getDependentEntries (id: string, keyPrefix: string): Promise<CacheEntry[]>
  deleteIds (ids: string[], keyPrefix: string): Promise<void>
  close (): Promise<void>
}

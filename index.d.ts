import { EventEmitter, Writable } from "node:stream";
import { Cluster, ClusterNode, ClusterOptions, Redis, RedisOptions } from "iovalkey";
import { GetResult, CacheKey, CachedResponse } from "./lib/internal-types";

export interface RedisCacheStoreOpts {
  clientConfigTracking?: boolean

  /**
   * Use an existing client instead of creating one. It is not closed by
   * `close()`. Pass a `Cluster` instance to use Valkey/Redis Cluster.
   */
  client?: Redis | Cluster

  /**
   * Defaults to "cluster" when `clusterUrl` or `startupNodes` is set.
   */
  mode?: "standalone" | "cluster" | "auto"

  /**
   * Single Valkey/Redis Cluster endpoint. This can be an AWS ElastiCache
   * configuration endpoint host or a redis:// / rediss:// URL.
   */
  clusterUrl?: string

  startupNodes?: ClusterNode | ClusterNode[]

  clusterOptions?: ClusterOptions

  /**
   * Prefix added to every key. Defaults to `clientOpts.keyPrefix`.
   */
  keyPrefix?: string

  clientOpts?: RedisOptions
  
  maxEntrySize?: number

  maxSize?: number

  maxCount?: number
  
  /**
   * Redis client-side caching. Not available in cluster mode.
   * @see https://redis.io/docs/latest/develop/reference/client-side-caching/
   * @default true
   */
  tracking?: boolean
  
  cacheTagsHeader?: string

  errorCallback?: (err: Error) => void
}

export interface RedisCacheManagerOpts {
  clientConfigKeyspaceEventNotify?: boolean

  clientOpts?: RedisOptions
}

declare class RedisCacheStore extends EventEmitter {
  constructor(opts?: RedisCacheStoreOpts);

  get(key: CacheKey): Promise<GetResult | undefined>

  createWriteStream(key: CacheKey, value: CachedResponse): Writable

  delete(key: CacheKey): Promise<void>

  deleteKeys(keys: CacheKey[]): Promise<void>

  deleteTags(tags: Array<string | string[]>): Promise<void>

  close(): Promise<void>
}

export interface CacheEntry {
  id: string;
  keyPrefix: string;
  origin: string;
  path: string;
  method: string;
  statusCode: number;
  headers: Record<string, string | string[]>;
  cacheTags: string[];
  cachedAt: number;
  staleAt: number;
  deleteAt: number;
}

declare class RedisCacheManager extends EventEmitter{
  constructor(opts?: RedisCacheManagerOpts);

  streamEntries(
    callback: (entry: CacheEntry) => Promise<unknown> | unknown,
    keyPrefix: string,
  ): Promise<void>

  subscribe(): Promise<void>

  getResponseById(id: string, keyPrefix: string): Promise<string | null>

  getDependentEntries(id: string, keyPrefix: string): Promise<CacheEntry[]>

  deleteIds (ids: string[], keyPrefix: string): Promise<void>

  close(): Promise<void>
}

export {
  RedisCacheStore,
  RedisCacheManager
}

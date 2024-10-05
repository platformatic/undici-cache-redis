import { RedisOptions } from "iovalkey";
import RedisCacheStore from "./lib/redis-cache-store";

export interface RedisCacheStoreOpts {
  clientOpts?: RedisOptions
  maxEntries?: number
  maxEntrySize?: number
  /**
   * Redis client-side caching
   * @see https://redis.io/docs/latest/develop/reference/client-side-caching/
   * @default true
   */
  tracking?: boolean
}

export {
  RedisCacheStore
}

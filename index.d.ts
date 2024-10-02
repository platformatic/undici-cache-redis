import { RedisOptions } from "iovalkey";
import RedisCacheStore from "./lib/redis-cache-store";

export interface RedisCacheStoreOpts {
  clientOpts?: RedisOptions
  maxEntries: number
  maxEntrySize: number
}

export {
  RedisCacheStore
}

import { Readable, Writable } from "node:stream";
import { RedisOptions } from "iovalkey";
import { Dispatcher } from "undici";

export interface RedisCacheStoreOpts {
  clientOpts?: RedisOptions
  maxEntrySize?: number
  /**
   * Redis client-side caching
   * @see https://redis.io/docs/latest/develop/reference/client-side-caching/
   * @default true
   */
  tracking?: boolean
  errorCallback?: (err: Error) => void
}

declare class RedisCacheStore {
  constructor(opts?: RedisCacheStoreOpts);

  get isFull(): boolean

  close(): Promise<void>

  createReadStream(req: Dispatcher.RequestOptions): Promise<RedisStoreReadable | undefined>

  createWriteStream(req: Dispatcher.RequestOptions, opts: CacheStoreValue): RedisStoreWritable | undefined
}

interface RedisStoreReadable extends Readable {
  get value(): CacheStoreValue
}

interface RedisStoreWritable extends Writable {
  set rawTrailers(trailers: string[] | undefined)
}

// TODO: remove when there's a type upstream
interface CacheStoreValue {
  statusCode: number;
  statusMessage: string;
  rawHeaders: (Buffer | Buffer[])[];
  rawTrailers?: string[];
  /**
   * Headers defined by the Vary header and their respective values for
   *  later comparison
   */
  vary?: Record<string, string>;
  /**
   * Time in millis that this value was cached
   */
  cachedAt: number;
  /**
   * Time in millis that this value is considered stale
   */
  staleAt: number;
  /**
   * Time in millis that this value is to be deleted from the cache. This is
   *  either the same as staleAt or the `max-stale` caching directive.
   */
  deleteAt: number;
}

export {
  RedisCacheStore
}

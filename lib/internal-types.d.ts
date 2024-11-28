// TODO: delete this file when the types land in v7

export interface CacheKey {
  origin: string
  method: string
  path: string
  headers?: Record<string, string | string[]>
}

export interface DeleteByUri {
  origin: string
  method: string
  path: string
}

export type GetResult = CachedResponse & { body: null | Readable | Iterable<Buffer> | Buffer | Iterable<string> | string }

/**
 * Underlying storage provider for cached responses
 */
export interface CacheStore {
  /**
   * Whether or not the cache is full and can not store any more responses
   */
  readonly isFull?: boolean

  get(key: CacheKey): GetResult | Promise<GetResult | undefined> | undefined

  createWriteStream(key: CacheKey, value: CachedResponse): Writable | undefined

  delete(key: CacheKey): void | Promise<void>

  deleteKeys(keys: CacheKey[]): void | Promise<void>;
}

export interface CachedResponse {
  statusCode: number;
  statusMessage: string;
  headers?: Record<string, string | string[]>
  /**
   * Headers defined by the Vary header and their respective values for
   *  later comparison
   */
  vary?: Record<string, string | string[]>
  /**
   * Time in millis that this value was cached
   */
  cachedAt: number
  /**
   * Time in millis that this value is considered stale
   */
  staleAt: number
  /**
   * Time in millis that this value is to be deleted from the cache. This is
   *  either the same as staleAt or the `max-stale` caching directive.
   */
  deleteAt: number
}

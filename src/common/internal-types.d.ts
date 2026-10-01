import { Writable, Readable } from 'node:stream'

export interface CacheKey {
  id?: string
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

export type GetResult = CachedResponse & { body: undefined | Readable | Iterable<Buffer> | Buffer | Iterable<string> | string }

export interface CacheStore {
  readonly isFull?: boolean

  get(key: CacheKey): GetResult | Promise<GetResult | undefined> | undefined

  createWriteStream(key: CacheKey, value: CachedResponse): Writable | undefined

  delete(key: CacheKey): void | Promise<void>

  deleteKeys(keys: CacheKey[]): void | Promise<void>
}

export interface CachedResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
  vary?: Record<string, string | string[]>
  cachedAt: number
  staleAt: number
  deleteAt: number
  cacheControlDirectives: Record<string, string | string[]>
}

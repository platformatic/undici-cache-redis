import { Redis, type RedisOptions } from 'iovalkey'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { EventEmitter } from 'node:stream'
import type { TestContext } from 'node:test'
import { createGunzip, createGzip } from 'node:zlib'
import {
  createManager as _createManager,
  createStore as _createStore,
  ensureArray,
  type CacheKey,
  type CacheManager,
  type CacheManagerOptions,
  type CacheStore,
  type CacheStoreOptions
} from '../src/index.ts'
import { KeysStorage, type CleanupTask, type Keys } from '../src/v2/index.ts'

let version: string | undefined
let database: number = -1

export async function gzip (data: Buffer | string): Promise<Buffer> {
  const gzippedData: Buffer[] = []
  const stream = createGzip()

  stream.on('data', data => {
    gzippedData.push(data)
  })

  stream.end(data)
  await once(stream, 'end')

  return Buffer.concat(gzippedData)
}

export async function ungzip (data: Buffer | ArrayBuffer): Promise<Buffer> {
  const ungzippedData: Buffer[] = []
  const stream = createGunzip()

  stream.on('data', data => {
    ungzippedData.push(data)
  })

  stream.end(Buffer.from(data as Buffer))
  await once(stream, 'end')

  return Buffer.concat(ungzippedData)
}

export function setVersion (newVersion: string) {
  version = newVersion
}

export async function selectDatabase (options?: Partial<RedisOptions>): Promise<number> {
  if (database !== -1) {
    return database
  }

  if (!options) {
    options = redisOptions
  }

  const client = new Redis(options)
  database = await client.incr('undici-cache-redis-db-counter')
  await client.expire('undici-cache-redis-db-counter', 3600)
  await client.quit()
  database = database % 16

  return database
}

export async function clearPrefix (prefix: string, options?: Partial<RedisOptions>): Promise<void> {
  if (!options) {
    options = redisOptions
  }

  options.db ??= await selectDatabase(options)

  // Clean the prefix
  const client = new Redis(options)

  let cursor = '0'
  const match = `${prefix}*`
  const batchSize = 500

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', batchSize)
    cursor = nextCursor

    if (keys.length === 0) {
      continue
    }

    await client.unlink(...keys)
  } while (cursor !== '0')

  await client.quit()
}

export async function preparePrefix (
  t: TestContext,
  prefix?: string,
  options?: Partial<RedisOptions>
): Promise<string> {
  if (!prefix) {
    prefix = `${crypto.randomUUID()}:`
  }

  await clearPrefix(prefix, options)

  t.after(async () => {
    await clearPrefix(prefix as string, options)
  })

  return prefix
}

export function getStorageKeys (key: Partial<CacheKey>, prefix: string): Keys {
  return new KeysStorage().get(key, prefix)
}

export async function getPrefixedKeys (
  prefix: string,
  options?: Partial<RedisOptions>,
  separator: string = '|'
): Promise<string[]> {
  const client = new Redis({ ...redisOptions, ...options })

  let cursor = '0'
  const match = `${prefix}${separator}*`
  const batchSize = 500

  const allKeys: string[] = []
  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', batchSize)
    cursor = nextCursor

    if (keys.length === 0) {
      continue
    }

    allKeys.push(...keys)
  } while (cursor !== '0')

  await client.quit()
  return allKeys
}

export async function createStore (t: TestContext, options?: Partial<CacheStoreOptions>): Promise<CacheStore> {
  options ??= {}
  options.clientOpts ??= redisOptions
  options.clientOpts.db ??= await selectDatabase(options.clientOpts)

  const store = _createStore(options, version)
  t.after(() => store.close())
  return store
}

export async function createManager (t: TestContext, options?: Partial<CacheManagerOptions>): Promise<CacheManager> {
  options ??= {}
  options.clientOpts ??= redisOptions
  options.clientOpts.db ??= await selectDatabase(options.clientOpts)

  const manager = _createManager(options, version)
  t.after(() => manager.close())
  return manager
}

export async function waitForEvents (
  sources: EventEmitter | EventEmitter[],
  event: string,
  count: number,
  fn?: () => Promise<any> | any
): Promise<void> {
  sources = ensureArray(sources)

  const { promise, resolve } = Promise.withResolvers<void>()

  let writes = 0

  function onWrite () {
    writes++

    if (writes >= count) {
      for (const source of sources as EventEmitter[]) {
        source.off(event, onWrite)
      }

      resolve()
    }
  }

  for (const source of sources as EventEmitter[]) {
    source.on(event, onWrite)
  }

  if (fn) {
    await fn()
  }

  return promise
}

export async function waitForCleanup (
  sources: EventEmitter | EventEmitter[],
  tasks: CleanupTask | CleanupTask[],
  fn?: () => Promise<any> | any
): Promise<void> {
  sources = ensureArray(sources)

  const remaining = new Set<string>()

  for (const task of ensureArray(tasks)) {
    switch (task.type) {
      case 'key':
        for (const key of ensureArray(task.target as string[])) {
          remaining.add(key)
        }

        break
      case 'tags':
        for (const tag of ensureArray(task.target as string[])) {
          remaining.add(`${task.type}|${task.prefix}|${tag}`)
        }

        break
    }
  }

  const { promise, resolve } = Promise.withResolvers<void>()

  function onCleanup (task: CleanupTask) {
    switch (task.type) {
      case 'key':
        for (const key of ensureArray(task.target as string[])) {
          remaining.delete(key)
        }

        break

      case 'tags':
        for (const tag of ensureArray(task.target as string[])) {
          const key = `${task.type}|${task.prefix}|${tag}`

          remaining.delete(key)
        }

        break
    }

    if (remaining.size === 0) {
      for (const source of sources as EventEmitter[]) {
        source.off('cleanup:task', onCleanup)
      }

      resolve()
    }
  }

  for (const source of sources as EventEmitter[]) {
    source.on('cleanup:task', onCleanup)
  }

  if (fn) {
    await fn()
  }

  return promise
}

export function createTags (count: number): string[] {
  const tags: string[] = []
  for (let i = 0; i < count; i++) {
    tags.push(randomBytes(8).toString('hex'))
  }

  return tags
}

export function listTags (tags: string[], ...indexes: number[]): string[] {
  return indexes.map(i => tags[i - 1])
}

export function createTagsHeader (tags: string[], ...indexes: number[]): string {
  return listTags(tags, ...indexes).join(',')
}

export const redisOptions = { port: 7001 }

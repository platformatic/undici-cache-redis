// @ts-check
'use strict'

const { EventEmitter } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const { addKeyPrefix, parseIdKey, parseMetadataKey, parseTagsKey } = require('./keys.js')
const { parseIndexEntry, deleteEntry } = require('./entries.js')

/**
 * @typedef {import('./entries.js').Context & { abortController: AbortController }} Context
 */

class RedisCacheManager extends EventEmitter {
  /**
   * @type {import('iovalkey').Redis}
   */
  #redis

  /**
   * @type {import('iovalkey').Redis}
   */
  #redisSubscribe

  /**
   * @type {boolean}
   */
  #subscribed = false

  /**
   * @type {boolean}
   */
  #closed = false

  /**
    * @type {import('iovalkey').RedisOptions}
    */
  #redisClientOpts

  /**
   * @type {AbortController}
   */
  #abortController

  /**
   * @type {Context}
   */
  #context

  /**
   * @type {boolean}
   */
  #clientConfigKeyspaceEventNotify

  /**
   * @param {import('../index.d.ts').RedisCacheManagerOpts | undefined} opts
   */
  constructor (opts) {
    super()

    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('expected opts to be an object')
      }

      this.#redisClientOpts = opts.clientOpts ?? {}
    }

    if (typeof opts?.clientConfigKeyspaceEventNotify === 'boolean') {
      this.#clientConfigKeyspaceEventNotify = opts.clientConfigKeyspaceEventNotify
    } else {
      this.#clientConfigKeyspaceEventNotify = true
    }

    if (!this.#redisClientOpts) this.#redisClientOpts = {}

    this.#redis = new Redis({
      enableAutoPipelining: true,
      ...this.#redisClientOpts
    })

    this.#abortController = new AbortController()

    this.#context = {
      redis: this.#redis,
      abortController: this.#abortController,
      keyPrefix: ''
    }
  }

  /**
   * @param {(entry: import('../index.d.ts').CacheEntry) => Promise<unknown> | unknown} callback
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async streamEntries (callback, keyPrefix = '') {
    const context = { ...this.#context, keyPrefix }

    await scanByPattern(context, `${keyPrefix}ids:*`, async (keys) => {
      const promises = new Array(keys.length)

      for (let i = 0; i < keys.length; i++) {
        const { keyPrefix } = parseIdKey(keys[i])
        promises[i] = this.#getEntryByIdKey(keys[i], keyPrefix)
          .then(entry => { if (entry !== undefined) { callback(entry) } })
      }

      await Promise.all(promises)
    })
  }

  async subscribe () {
    if (this.#subscribed) return
    this.#subscribed = true

    try {
      if (this.#clientConfigKeyspaceEventNotify) {
        await this.#redis.send_command('CONFIG', [
          'SET', 'notify-keyspace-events', 'AKE'
        ])
      }

      this.#redisSubscribe = new Redis(this.#redisClientOpts)

      await this.#redisSubscribe.subscribe(
        '__keyevent@0__:hset',
        '__keyevent@0__:del',
        '__keyevent@0__:expired'
      )
    } catch (err) {
      this.#subscribed = false
      await this.#redisSubscribe?.quit()

      throw err
    }

    this.#redisSubscribe.on('message', async (channel, key) => {
      try {
        if (key.includes('ids:')) {
          const { keyPrefix, id } = parseIdKey(key)

          // A new cache entry was added
          if (channel === '__keyevent@0__:hset') {
            const cacheEntry = await this.#getEntryByIdKey(key, keyPrefix)
            if (cacheEntry !== undefined) {
              this.emit('add-entry', cacheEntry)
            }
            return
          }

          // A cache entry was deleted
          if (
            channel === '__keyevent@0__:del' ||
            channel === '__keyevent@0__:expired'
          ) {
            this.emit('delete-entry', { id, keyPrefix })
          }
          return
        }

        if (key.includes('cache-tags:')) {
          const { tags } = parseTagsKey(key)

          // A cache entry was deleted by tag
          if (
            channel === '__keyevent@0__:del' ||
            channel === '__keyevent@0__:expired'
          ) {
            await deleteTagsInAllPrefixes(this.#context, tags)
          }
        }
      } catch (err) {
        this.emit('error', err)
      }
    })
  }

  /**
   * @param {string} id
   * @param {string} keyPrefix
   * @returns {Promise<string | null>}
   */
  async getResponseById (id, keyPrefix = '') {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    if (!metadataKey) return null

    const { valueKey } = await this.#redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
    if (!valueKey) return null

    const value = await this.#redis.get(addKeyPrefix(valueKey, keyPrefix))
    if (!value) return null

    const parsedValue = JSON.parse(value)
    const base64Body = parsedValue.body.join('')

    return Buffer.from(base64Body, 'base64').toString('utf8')
  }

  /**
   * @param {string} id
   * @param {string} keyPrefix
   * @returns {Promise<import('../index.d.ts').CacheEntry[]>}
   */
  async getDependentEntries (id, keyPrefix = '') {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    if (!metadataKey) return []

    const { tagsKey } = await this.#redis.hgetall(
      addKeyPrefix(metadataKey, keyPrefix)
    )
    if (!tagsKey) return []

    const { tags } = parseTagsKey(tagsKey)
    if (tags.length === 0) return []

    const entries = []
    const pattern = `*cache-tags:*${tags.sort().join('*:*')}:*`

    const fullTagsKey = addKeyPrefix(tagsKey, keyPrefix)

    await scanByPattern(this.#context, pattern, async (keys) => {
      const promises = []
      for (const key of keys) {
        if (key === fullTagsKey) continue

        const { keyPrefix } = parseTagsKey(key)
        promises.push(this.#getEntryByTagsKey(key, keyPrefix)
          .then((entry) => { if (entry !== undefined) entries.push(entry) }))
      }
      await Promise.all(promises)
    })

    return entries
  }

  /**
   * @param {string[]} ids
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async deleteIds (ids, keyPrefix = '') {
    const context = { ...this.#context, keyPrefix }
    await Promise.all(ids.map(async (id) => {
      const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
      if (metadataKey) await deleteByMetadataKey(context, metadataKey)
    }))
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    if (this.#closed) return
    this.#closed = true
    this.#abortController.abort()

    // Wait for scan operations abortions
    await sleep(100)

    const promises = [this.#redis.quit()]
    if (this.#subscribed) {
      promises.push(this.#redisSubscribe.quit())
    }
    await Promise.all(promises)
  }

  /**
   * @param {string} idKey
   * @param {string} keyPrefix
   * @returns {Promise<import('../index.d.ts').CacheEntry | undefined>}
   */
  async #getEntryByIdKey (idKey, keyPrefix = '') {
    const { metadataKey } = await this.#redis.hgetall(
      addKeyPrefix(idKey, keyPrefix)
    )
    if (!metadataKey) return

    return this.#getEntryByMetadataKey(metadataKey, keyPrefix)
  }

  /**
   * @param {string} tagsKey
   * @param {string} keyPrefix
   * @returns {Promise<import('../index.d.ts').CacheEntry | undefined>}
   */
  async #getEntryByTagsKey (tagsKey, keyPrefix = '') {
    const { metadataKey } = await this.#redis.hgetall(
      addKeyPrefix(tagsKey, keyPrefix)
    )
    if (!metadataKey) return

    return this.#getEntryByMetadataKey(metadataKey, keyPrefix)
  }

  /**
   * @param {string} metadataKey
   * @param {string} keyPrefix
   * @returns {Promise<import('../index.d.ts').CacheEntry | undefined>}
   */
  async #getEntryByMetadataKey (metadataKey, keyPrefix = '') {
    const { valueKey, tagsKey } = await this.#redis.hgetall(
      addKeyPrefix(metadataKey, keyPrefix)
    )
    if (!valueKey) return

    const value = await this.#redis.get(
      addKeyPrefix(valueKey, keyPrefix)
    )
    if (!value) return

    const parsedMetaKey = parseMetadataKey(metadataKey)
    const parsedValue = JSON.parse(value)

    return {
      id: parsedMetaKey.id,
      keyPrefix,
      origin: parsedMetaKey.origin,
      path: parsedMetaKey.path,
      method: parsedMetaKey.method,
      statusCode: parsedValue.statusCode,
      headers: parsedValue.headers,
      cacheTags: tagsKey ? parseTagsKey(tagsKey).tags : [],
      cachedAt: parsedValue.cachedAt,
      staleAt: parsedValue.staleAt,
      deleteAt: parsedValue.deleteAt
    }
  }
}

/**
 * Deletes the entry a metadata key belongs to.
 * @param {Context} ctx
 * @param {string} metadataKey
 * @returns {Promise<void>}
 */
async function deleteByMetadataKey (ctx, metadataKey) {
  const { redis, keyPrefix } = ctx
  metadataKey = addKeyPrefix(metadataKey, keyPrefix)

  const metadata = await redis.hgetall(metadataKey)
  const entry = metadata.indexKey
    ? parseIndexEntry(await redis.hget(metadata.indexKey, metadata.indexField))
    : undefined

  if (entry?.id === parseMetadataKey(metadataKey).id) {
    await deleteEntry(ctx, entry)
    return
  }

  // Not indexed (anymore), only the keys listed in the metadata are left
  await Promise.all([metadataKey, metadata.idKey, metadata.valueKey, metadata.tagsKey]
    .filter(Boolean)
    .map(key => redis.del(addKeyPrefix(key, keyPrefix))))
}

/**
 * Deletes the entries that have all of the tags, in every key prefix.
 * @param {Context} ctx
 * @param {string[]} tags
 * @returns {Promise<void>}
 */
async function deleteTagsInAllPrefixes (ctx, tags) {
  const pattern = `*cache-tags:*${[...tags].sort().join('*:*')}:*`

  await scanByPattern(ctx, pattern, async (keys) => {
    await Promise.all(keys.map(async (tagsKey) => {
      const { keyPrefix } = parseTagsKey(tagsKey)
      const { metadataKey } = await ctx.redis.hgetall(tagsKey)
      if (!metadataKey) return

      await ctx.redis.del(tagsKey)
      await deleteByMetadataKey({ ...ctx, keyPrefix }, metadataKey)
    }))
  })
}

/**
 * @param {Context} ctx
 * @param {string} pattern
 * @param {(keys: string[]) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function scanByPattern (ctx, pattern, callback) {
  const { redis, keyPrefix, abortController } = ctx

  /**
   * @type {Promise<void|Error>[]}
   */
  const promises = []
  let cursor = '0'

  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', addKeyPrefix(pattern, keyPrefix), 'COUNT', '1000')
      if (keys.length > 0) promises.push(callback(keys).catch(err => err))
      cursor = nextCursor
    } while (cursor !== '0' && !abortController.signal.aborted)
  } finally {
    await Promise.allSettled(promises).then((results) => {
      const errors = results.filter(({ value }) => value instanceof Error)
      if (errors.length > 0) {
        throw new Error('Error(s) occurred during scanByPattern operation', { cause: errors })
      }
    })
  }
}

module.exports = RedisCacheManager

// exported for unittests only.
module.exports._scanByPattern = scanByPattern

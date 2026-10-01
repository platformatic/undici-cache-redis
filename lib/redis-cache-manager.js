// @ts-check
'use strict'

const { EventEmitter } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { Redis } = require('iovalkey')
const { addKeyPrefix, parseMetadataKey, parseIdKey, parseTagsKey } = require('./keys.js')
const { deleteByMetadataKey, deleteTags, scanByPattern } = require('./entries.js')

/**
 * @typedef {import('./entries.js').Context} Context
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
      this.subscribed = false
      await this.#redisSubscribe.quit()

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
            await deleteTags(this.#context, tags, { global: true })
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
    const value = await this.#redis.get(`${keyPrefix}values:${id}`)
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
      const promises = new Array(keys.length)
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === fullTagsKey) continue

        const { keyPrefix } = parseTagsKey(keys[i])
        promises[i] = this.#getEntryByTagsKey(keys[i], keyPrefix)
          .then((entry) => { if (entry !== undefined) entries.push(entry) })
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
    const promises = []
    for (const id of ids) {
      promises.push(this.#deleteById(id, keyPrefix))
    }
    await Promise.all(promises)
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
    const { id } = parseMetadataKey(metadataKey)

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

    let cacheTags = []
    if (tagsKey) {
      const { tags } = parseTagsKey(tagsKey)
      cacheTags = tags
    }

    return {
      id,
      keyPrefix,
      origin: parsedMetaKey.origin,
      path: parsedMetaKey.path,
      method: parsedMetaKey.method,
      statusCode: parsedValue.statusCode,
      headers: parsedValue.headers,
      cacheTags,
      cachedAt: parsedValue.cachedAt,
      staleAt: parsedValue.staleAt,
      deleteAt: parsedValue.deleteAt
    }
  }

  /**
   * @param {string} id
   * @param {string} keyPrefix
   * @returns {Promise<void>}
   */
  async #deleteById (id, keyPrefix = '') {
    const { metadataKey } = await this.#redis.hgetall(`${keyPrefix}ids:${id}`)
    if (!metadataKey) return

    await deleteByMetadataKey(this.#context, metadataKey)
  }
}

module.exports = RedisCacheManager

// exported for unittests only.
module.exports._scanByPattern = scanByPattern

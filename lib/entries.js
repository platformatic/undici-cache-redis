// @ts-check
'use strict'

const { addKeyPrefix, parseMetadataKey, parseTagsKey } = require('./keys.js')

/**
 * @typedef {{
 * redis: import('iovalkey').Redis;
 * trackingCache?: import('./tracking-cache.js') | undefined;
 * abortController: AbortController;
 * keyPrefix: string;
 * }} Context
 */

/**
  * @param {Context} ctx
  * @param {string} metadataKey
  * @returns {Promise<void>}
  */
async function deleteByMetadataKey (ctx, metadataKey) {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(metadataKey, keyPrefix))
  if (!metadata.valueKey) return

  const { idKey, valueKey, tagsKey } = metadata

  const promises = [
    redis.del(addKeyPrefix(metadataKey, keyPrefix)),
    redis.del(addKeyPrefix(idKey, keyPrefix)),
    redis.del(addKeyPrefix(valueKey, keyPrefix))
  ]

  if (ctx.trackingCache) {
    ctx.trackingCache.delete(parseMetadataKey(metadataKey))
  }

  if (tagsKey) {
    const { id, tags } = parseTagsKey(tagsKey)
    promises.push(redis.del(addKeyPrefix(tagsKey, keyPrefix)))
    promises.push(deleteTags(ctx, tags, id))
  }

  await Promise.all(promises)
}

/**
  * @param {Context} ctx
  * @param {string[]} tags
  * @param {{ global?: boolean }} [opts]
  * @returns {Promise<void>}
  */
async function deleteTags (ctx, tags, opts = {}) {
  tags = tags.filter(tag => tag.length > 0)
  if (tags.length === 0) return

  const global = opts.global ?? false
  const prefix = global ? '*' : ''
  const pattern = `${prefix}cache-tags:*${tags.sort().join('*:*')}:*`

  await scanByPattern(ctx, pattern, async (keys) => {
    const promises = new Array(keys.length)
    for (let i = 0; i < keys.length; i++) {
      const { keyPrefix } = parseTagsKey(keys[i])
      const context = { ...ctx, keyPrefix }
      promises[i] = deleteByTagKey(context, keys[i])
    }
    await Promise.all(promises)
  })
}

/**
  * @param {Context} ctx
  * @param {string} tagKey
  * @returns {Promise<void>}
  */
async function deleteByTagKey (ctx, tagKey) {
  const { redis, keyPrefix } = ctx

  const metadata = await redis.hgetall(addKeyPrefix(tagKey, keyPrefix))
  if (!metadata.metadataKey) return

  await redis.del(addKeyPrefix(tagKey, keyPrefix))
  await deleteByMetadataKey(ctx, metadata.metadataKey)
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

module.exports = {
  deleteByMetadataKey,
  deleteTags,
  scanByPattern
}

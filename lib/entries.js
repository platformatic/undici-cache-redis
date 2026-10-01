// @ts-check
'use strict'

const { randomBytes } = require('node:crypto')
const { entryKeys, indexKey, tagIndexKey, tagIndexMember, parseTagIndexMember } = require('./keys.js')
const { normalizeHeaders, varyMatches } = require('./vary.js')

// Removes a hash field only if it still holds the value that was read
const HDEL_IF_UNCHANGED = "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) end return 0"

/**
 * Commands are sent without waiting between them. With auto pipelining they
 * are batched, and commands for the same slot run in the order they are sent.
 *
 * @typedef {import('./keys.js').IndexEntry} IndexEntry
 *
 * @typedef {{
 *  redis: import('iovalkey').Redis | import('iovalkey').Cluster
 *  keyPrefix: string
 *  trackingCache?: import('./tracking-cache.js')
 * }} Context
 */

/**
 * @param {string | null | undefined} value
 * @returns {IndexEntry | undefined}
 */
function parseIndexEntry (value) {
  if (!value) return

  try {
    const entry = JSON.parse(value)
    if (typeof entry?.writeId === 'string' && Array.isArray(entry.tags)) {
      return entry
    }
  } catch {}
}

/**
 * Picks the most specific live entry of an index that matches the request.
 * @param {Record<string, string>} fields
 * @param {import('./internal-types.d.ts').CacheKey} key
 * @returns {IndexEntry | undefined}
 */
function findBestEntry (fields, key) {
  const now = Date.now()
  let headers
  let best
  let bestVaryCount = -1

  for (const field in fields) {
    const entry = parseIndexEntry(fields[field])
    if (!entry || entry.method !== key.method || entry.deleteAt <= now) continue

    const varyCount = entry.vary ? Object.keys(entry.vary).length : 0
    if (varyCount <= bestVaryCount) continue

    headers ??= normalizeHeaders(key.headers)
    if (varyMatches(entry.vary, headers)) {
      best = entry
      bestVaryCount = varyCount
    }
  }

  return best
}

/**
 * Stores an entry, replacing the previous entry for the same variant and
 * dropping expired variants of the URL.
 * @param {Context} ctx
 * @param {Omit<IndexEntry, 'writeId'>} variant
 * @param {string} serializedValue
 * @returns {Promise<void>}
 */
async function writeEntry (ctx, variant, serializedValue) {
  const { redis, keyPrefix } = ctx
  const entry = { ...variant, writeId: randomBytes(8).toString('base64url') }
  const keys = entryKeys(keyPrefix, entry)
  const deleteAt = String(entry.deleteAt)
  const fields = await redis.hgetall(keys.index)
  const now = Date.now()

  // Lookups already in flight must not cache what they read before this write
  ctx.trackingCache?.deleteGroup(keys.index)

  const pending = []
  for (const field in fields) {
    const other = parseIndexEntry(fields[field])
    if (other?.field === entry.field) {
      pending.push(...cleanupEntry(ctx, other, entry))
    } else if (other && other.deleteAt <= now) {
      // Its keys expired with it. The variant can be rewritten concurrently,
      // so the field is only removed if it still holds the expired entry.
      pending.push(
        redis.eval(HDEL_IF_UNCHANGED, 1, keys.index, field, fields[field]),
        ...removeTagMemberships(ctx, other)
      )
    }
  }

  if (keys.tags) {
    pending.push(
      redis.hset(keys.tags, 'metadataKey', keys.metadata),
      redis.pexpireat(keys.tags, deleteAt)
    )
  }

  pending.push(
    redis.set(keys.value, serializedValue, 'PXAT', deleteAt),
    redis.hset(keys.metadata, {
      idKey: keys.id,
      valueKey: keys.value,
      tagsKey: keys.tags ?? '',
      indexKey: keys.index,
      indexField: entry.field
    }),
    redis.pexpireat(keys.metadata, deleteAt),
    redis.hset(keys.id, 'metadataKey', keys.metadata),
    redis.pexpireat(keys.id, deleteAt),
    // The index is written last so it never references a missing value. A new
    // index gets the entry's expiration, an existing one is only extended.
    redis.hset(keys.index, entry.field, JSON.stringify(entry)),
    ...extendExpiration(redis, keys.index, deleteAt)
  )

  const member = tagIndexMember(keyPrefix, entry)
  for (const tag of entry.tags) {
    const key = tagIndexKey(keyPrefix, tag)
    pending.push(redis.sadd(key, member), ...extendExpiration(redis, key, deleteAt))
  }

  await Promise.all(pending)
}

/**
 * Deletes an entry and, like the original implementation, every entry that
 * shares all of its cache tags.
 * @param {Context} ctx
 * @param {IndexEntry} entry
 * @param {boolean} [cascade]
 * @returns {Promise<void>}
 */
async function deleteEntry (ctx, entry, cascade = true) {
  ctx.trackingCache?.deleteGroup(indexKey(ctx.keyPrefix, entry))
  await Promise.all(cleanupEntry(ctx, entry))

  if (cascade && entry.tags.length > 0) {
    await deleteTags(ctx, entry.tags)
  }
}

/**
 * Makes a key live at least until `deleteAt`, without shortening it. Both
 * commands are needed: the key may have been created without an expiration
 * by this write, or by a concurrent one.
 * @param {Context['redis']} redis
 * @param {string} key
 * @param {string} deleteAt
 * @returns {Promise<unknown>[]}
 */
function extendExpiration (redis, key, deleteAt) {
  return [redis.pexpireat(key, deleteAt, 'NX'), redis.pexpireat(key, deleteAt, 'GT')]
}

/**
 * Deletes the keys of `previous` that `next` doesn't overwrite, and its tag
 * memberships. Without `next`, the entry is deleted.
 * @param {Context} ctx
 * @param {IndexEntry} previous
 * @param {IndexEntry} [next]
 * @returns {Promise<unknown>[]}
 */
function cleanupEntry ({ redis, keyPrefix }, previous, next) {
  const keys = entryKeys(keyPrefix, previous)
  const kept = next ? entryKeys(keyPrefix, next) : undefined
  const pending = []

  for (const name of /** @type {const} */ (['metadata', 'id', 'value', 'tags'])) {
    if (keys[name] && keys[name] !== kept?.[name]) {
      pending.push(redis.del(keys[name]))
    }
  }

  if (!next) {
    pending.push(redis.hdel(keys.index, previous.field))
  }

  return [...pending, ...removeTagMemberships({ redis, keyPrefix }, previous)]
}

/**
 * @param {Context} ctx
 * @param {IndexEntry} entry
 * @returns {Promise<unknown>[]}
 */
function removeTagMemberships ({ redis, keyPrefix }, entry) {
  const member = tagIndexMember(keyPrefix, entry)
  return entry.tags.map(tag => redis.srem(tagIndexKey(keyPrefix, tag), member))
}

/**
 * @param {Context} ctx
 * @param {string} indexKey
 * @param {string} [method] only delete the entries for this method
 * @returns {Promise<void>}
 */
async function deleteByIndex (ctx, indexKey, method) {
  const fields = await ctx.redis.hgetall(indexKey)
  const entries = Object.values(fields)
    .map(parseIndexEntry)
    .filter(entry => entry && (!method || entry.method === method))

  await Promise.all(entries.map(entry => deleteEntry(ctx, entry)))
}

/**
 * Deletes the entries of the context's prefix that have all of the tags.
 * @param {Context} ctx
 * @param {string[]} tags
 * @returns {Promise<void>}
 */
async function deleteTags (ctx, tags) {
  if (tags.length === 0) return

  const { redis, keyPrefix } = ctx
  const tagIndex = tagIndexKey(keyPrefix, tags[0])
  const members = await redis.smembers(tagIndex)

  await Promise.all(members.map(async (member) => {
    const { indexKey, field, writeId } = parseTagIndexMember(member)
    const entry = parseIndexEntry(await redis.hget(indexKey, field))

    if (entry?.writeId !== writeId) {
      // The write is gone or was replaced
      await redis.srem(tagIndex, member)
    } else if (tags.every(tag => entry.tags.includes(tag))) {
      await deleteEntry(ctx, entry, false)
    }
  }))
}

module.exports = {
  parseIndexEntry,
  findBestEntry,
  writeEntry,
  deleteEntry,
  deleteByIndex,
  deleteTags
}

// @ts-check
'use strict'

const { randomBytes } = require('node:crypto')
const { entryKeys, indexKey, tagIndexKey, tagIndexMember, parseTagIndexMember } = require('./keys.js')
const { normalizeHeaders, varyMatches } = require('./vary.js')

// All KEYS of these scripts are URL-local in cluster mode. Standalone keeps
// the manager's ids:{id} layout; cluster IDs also carry the URL hash tag.
// Check types before mutating: Redis scripts do not roll back runtime errors.
const WRITE_ENTRY = `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
local function hashkey(key)
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' and kind ~= 'hash' then error('WRONGTYPE cache hash') end
end
hashkey(KEYS[3])
hashkey(KEYS[4])
if ARGV[6] == '1' then hashkey(KEYS[5]) end
local clock = redis.call('TIME')
if tonumber(ARGV[5]) <= tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) then return -1 end
if ARGV[2] ~= '' then
  for i = 2, 4 do
    if KEYS[i + 4] ~= KEYS[i] then redis.call('DEL', KEYS[i + 4]) end
  end
  if ARGV[7] == '1' and KEYS[9] ~= KEYS[5] and redis.call('EXISTS', KEYS[9]) == 1 then
    -- Replacing tags is bookkeeping, not a tag purge. Avoid a cache-tags DEL
    -- notification that would make a subscribed manager purge the rewrite.
    local retired = KEYS[1] .. ':retired-tags'
    redis.call('RENAME', KEYS[9], retired)
    redis.call('DEL', retired)
  end
end
redis.call('SET', KEYS[2], ARGV[4], 'PXAT', ARGV[5])
redis.call('HSET', KEYS[3], 'idKey', KEYS[4], 'valueKey', KEYS[2],
  'tagsKey', ARGV[6] == '1' and KEYS[5] or '', 'indexKey', KEYS[1], 'indexField', ARGV[1])
redis.call('PEXPIREAT', KEYS[3], ARGV[5])
redis.call('HSET', KEYS[4], 'metadataKey', KEYS[3])
redis.call('PEXPIREAT', KEYS[4], ARGV[5])
if ARGV[6] == '1' then
  redis.call('HSET', KEYS[5], 'metadataKey', KEYS[3])
  redis.call('PEXPIREAT', KEYS[5], ARGV[5])
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[5], 'NX')
redis.call('PEXPIREAT', KEYS[1], ARGV[5], 'GT')
return 1
`

const DELETE_ENTRY = `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
if ARGV[3] == '1' then redis.call('DEL', KEYS[5]) end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`

const ADD_TAG_MEMBER = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[2], 'NX')
redis.call('PEXPIREAT', KEYS[1], ARGV[2], 'GT')
return 1
`
const TAG_BATCH_SIZE = 100

/**
 * Publication and deletion use version-checked scripts, not pipeline order.
 *
 * @typedef {import('./keys.js').IndexEntry} IndexEntry
 *
 * @typedef {{
 *  redis: import('iovalkey').Redis | import('iovalkey').Cluster
 *  keyPrefix: string
 *  isCluster?: boolean
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
  const keys = entryKeys(keyPrefix, entry, ctx.isCluster)
  const deleteAt = String(entry.deleteAt)
  const fields = await redis.hgetall(keys.index)

  ctx.trackingCache?.deleteGroup(keys.index)

  // Expired cleanup is conditional too: it must not remove a concurrent rewrite.
  await Promise.all(Object.values(fields).map(async (raw) => {
    const other = parseIndexEntry(raw)
    if (other && other.field !== entry.field && other.deleteAt <= Date.now()) {
      await deleteEntry(ctx, other, false)
    }
  }))

  let previousRaw = fields[entry.field] ?? ''
  let replaced
  for (;;) {
    const previous = parseIndexEntry(previousRaw)
    const old = previous ? entryKeys(keyPrefix, previous, ctx.isCluster) : keys
    const published = await redis.eval(WRITE_ENTRY, 9,
      keys.index, keys.value, keys.metadata, keys.id, keys.tags ?? keys.index,
      old.value, old.metadata, old.id, old.tags ?? keys.index,
      entry.field, previousRaw, JSON.stringify(entry), serializedValue, deleteAt,
      keys.tags ? '1' : '0', previous?.tags.length ? '1' : '0')
    if (published === -1) return
    if (published === 1) {
      replaced = previous
      break
    }
    previousRaw = await redis.hget(keys.index, entry.field) ?? ''
  }

  // Tag indexes use their own slots. Memberships identify immutable write IDs;
  // their scores allow hot tags to discard expired URLs on every write.
  const member = tagIndexMember(keyPrefix, entry)
  try {
    if (replaced) await Promise.all(removeTagMemberships(ctx, replaced))
    await Promise.all(entry.tags.map(tag => redis.eval(ADD_TAG_MEMBER, 1,
      tagIndexKey(keyPrefix, tag), String(Date.now()), deleteAt, member)))
  } catch (err) {
    // Do not leave a published response that cannot be invalidated by its tags.
    // The conditional script preserves a rewrite that completed meanwhile.
    try { await deleteEntry(ctx, entry, false) } catch {}
    throw err
  }
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
  const keys = entryKeys(ctx.keyPrefix, entry, ctx.isCluster)
  const deleted = await ctx.redis.eval(DELETE_ENTRY, 5,
    keys.index, keys.value, keys.metadata, keys.id, keys.tags ?? keys.index,
    entry.field, JSON.stringify(entry), keys.tags ? '1' : '0')
  await Promise.all(removeTagMemberships(ctx, entry))

  if (deleted && cascade && entry.tags.length > 0) {
    await deleteTags(ctx, entry.tags)
  }
}

/**
 * @param {Context} ctx
 * @param {IndexEntry} entry
 * @returns {Promise<unknown>[]}
 */
function removeTagMemberships ({ redis, keyPrefix }, entry) {
  const member = tagIndexMember(keyPrefix, entry)
  return entry.tags.map(tag => redis.zrem(tagIndexKey(keyPrefix, tag), member))
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
  await redis.zremrangebyscore(tagIndex, '-inf', Date.now())
  // Scan incrementally and bound concurrent lookups even when a compact
  // sorted set returns more than COUNT. Cleanup is idempotent for duplicates.
  let cursor = '0'
  do {
    const [next, page] = await redis.zscan(tagIndex, cursor, 'COUNT', TAG_BATCH_SIZE)
    cursor = next
    for (let start = 0; start < page.length; start += TAG_BATCH_SIZE * 2) {
      const batch = page.slice(start, start + TAG_BATCH_SIZE * 2)
      await Promise.all(batch.filter((_, i) => i % 2 === 0).map(async (member) => {
        const { indexKey, field, writeId } = parseTagIndexMember(member)
        const entry = parseIndexEntry(await redis.hget(indexKey, field))
        if (entry?.writeId !== writeId) {
          await redis.zrem(tagIndex, member)
        } else if (tags.every(tag => entry.tags.includes(tag))) {
          await deleteEntry(ctx, entry, false)
        }
      }))
    }
  } while (cursor !== '0')
}

module.exports = {
  parseIndexEntry,
  findBestEntry,
  writeEntry,
  deleteEntry,
  deleteByIndex,
  deleteTags
}

// @ts-check
'use strict'

const { createHash } = require('node:crypto')

/**
 * Key layout. `{u}` is a hash of origin + path. It is a Cluster hash tag, so
 * every key read by a lookup lives in the same slot, and it maps a tracking
 * invalidation of any of these keys back to its URL.
 *
 *  index:{u}                     hash: `${method}:${varyHash}` -> IndexEntry
 *  values:{u}:{id}               string: the cached response
 *  metadata:{u}:{origin}:{path}:{method}:{id}
 *                                hash: { idKey, valueKey, tagsKey, indexKey, indexField }
 *  ids:{id}                      hash: { metadataKey }
 *  cache-tags:{u}:{tags}:{id}    hash: { metadataKey }
 *  tag-index:{t}                 set: `${indexKey}\n${field}\n${writeId}` of each
 *                                entry with the tag
 *
 * The metadata, ids and cache-tags keys are only read by RedisCacheManager.
 *
 * @typedef {{
 *  id: string
 *  origin: string
 *  path: string
 *  method: string
 *  field: string
 *  writeId: string
 *  vary?: Record<string, string | string[] | null>
 *  tags: string[]
 *  deleteAt: number
 * }} IndexEntry
 */

/**
 * Recently computed URL hashes, so hot URLs are not hashed on every lookup
 * @type {Map<string, string>}
 */
const urlHashes = new Map()

/**
 * @param {{ origin: string, path: string }} url
 * @returns {string}
 */
function urlHash ({ origin, path }) {
  const url = `${origin}\n${path}`
  let result = urlHashes.get(url)

  if (result === undefined) {
    result = hash(url)
    if (urlHashes.size >= 10_000) {
      urlHashes.delete(urlHashes.keys().next().value)
    }
    urlHashes.set(url, result)
  }

  return result
}

/**
 * @param {string} keyPrefix
 * @param {{ origin: string, path: string }} url
 * @returns {string}
 */
function indexKey (keyPrefix, url) {
  return `${keyPrefix}index:{${urlHash(url)}}`
}

/**
 * The index keys of the URLs whose keys are listed in a tracking invalidation
 * @param {string} keyPrefix
 * @param {string} invalidatedKeys
 * @returns {string[]}
 */
function invalidatedIndexKeys (keyPrefix, invalidatedKeys) {
  const hashTags = invalidatedKeys.match(/\{[0-9a-f]{32}\}/g) ?? []
  return hashTags.map(hashTag => `${keyPrefix}index:${hashTag}`)
}

/**
 * @param {string} method
 * @param {Record<string, string | string[] | null> | undefined} vary normalized
 * @returns {string}
 */
function indexField (method, vary) {
  return `${method}:${vary ? hash(JSON.stringify(vary)) : 'no-vary'}`
}

/**
 * The id of an entry, unless the cache key has its own. It is the same for
 * every write of a variant, so a new write overwrites the previous one.
 * @param {{ origin: string, path: string }} url
 * @param {string} field
 * @returns {string}
 */
function entryId (url, field) {
  return `${urlHash(url)}-${field.replace(':', '-')}`
}

/**
 * @param {string} keyPrefix
 * @param {string} tag
 * @returns {string}
 */
function tagIndexKey (keyPrefix, tag) {
  return `${keyPrefix}tag-index:{${hash(tag)}}`
}

/**
 * Tag index members identify a single write, not just a variant, so that
 * removing the membership of one write can't remove that of a rewrite.
 * @param {string} keyPrefix
 * @param {IndexEntry} entry
 * @returns {string}
 */
function tagIndexMember (keyPrefix, entry) {
  return `${indexKey(keyPrefix, entry)}\n${entry.field}\n${entry.writeId}`
}

/**
 * @param {string} member
 * @returns {{ indexKey: string, field: string, writeId: string }}
 */
function parseTagIndexMember (member) {
  const [indexKey, field, writeId] = member.split('\n')
  return { indexKey, field, writeId }
}

/**
 * @param {string} keyPrefix
 * @param {IndexEntry} entry
 * @returns {{ index: string, value: string, metadata: string, id: string, tags: string | undefined }}
 */
function entryKeys (keyPrefix, entry) {
  const { id, origin, path, method, tags } = entry
  const u = urlHash(entry)

  return {
    index: `${keyPrefix}index:{${u}}`,
    value: `${keyPrefix}values:{${u}}:${id}`,
    metadata: `${keyPrefix}metadata:{${u}}:${encodeURIComponent(origin)}:${encodeURIComponent(path)}:${method}:${id}`,
    id: `${keyPrefix}ids:${id}`,
    tags: tags.length > 0 ? `${keyPrefix}cache-tags:{${u}}:${[...tags].sort().join(':')}:${id}` : undefined
  }
}

/**
 * @param {string} key
 * @returns {{ keyPrefix: string, origin: string, path: string, method: string, id: string }}
 */
function parseMetadataKey (key) {
  const typePrefix = 'metadata:'
  const splitIndex = key.indexOf(typePrefix)

  if (splitIndex === -1) {
    throw new Error(`Invalid cache metadata key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  const parts = key.slice(splitIndex + typePrefix.length).split(':')
  if (isHashTag(parts[0])) parts.shift()

  return {
    keyPrefix,
    origin: decodeURIComponent(parts[0]),
    path: decodeURIComponent(parts[1]),
    method: parts[2],
    id: parts.slice(3).join(':')
  }
}

/**
  * @param {string} key
  * @returns {{ keyPrefix: string, id: string }}
  */
function parseIdKey (key) {
  const typePrefix = 'ids:'
  const splitIndex = key.indexOf(typePrefix)

  if (splitIndex === -1) {
    throw new Error(`Invalid cache id key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  const id = key.slice(splitIndex + typePrefix.length)

  return { keyPrefix, id }
}

/**
 * @param {string} key
 * @returns {{ keyPrefix: string, tags: string[], id: string }}
 */
function parseTagsKey (key) {
  const typePrefix = 'cache-tags:'
  const splitIndex = key.indexOf(typePrefix)

  if (splitIndex === -1) {
    throw new Error(`Invalid cache tags key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  const parts = key.slice(splitIndex + typePrefix.length).split(':')
  if (isHashTag(parts[0])) parts.shift()
  const tags = parts.slice(0, -1)
  const id = parts[parts.length - 1]

  return { keyPrefix, tags, id }
}

/**
 * @param {string} key
 * @param {string | undefined} prefix
 * @returns {string}
 */
function addKeyPrefix (key, prefix) {
  return prefix && !key.startsWith(prefix) ? prefix + key : key
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isHashTag (segment) {
  return segment.startsWith('{') && segment.endsWith('}')
}

/**
 * @param {string} value
 * @returns {string}
 */
function hash (value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

module.exports = {
  indexKey,
  invalidatedIndexKeys,
  indexField,
  entryId,
  tagIndexKey,
  tagIndexMember,
  parseTagIndexMember,
  entryKeys,
  parseMetadataKey,
  parseIdKey,
  parseTagsKey,
  addKeyPrefix
}

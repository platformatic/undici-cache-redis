// @ts-check
'use strict'

/**
 * @param {string} key
 * @param {string | undefined} prefix
 * @returns {string}
 */
function addKeyPrefix (key, prefix) {
  return prefix && !key.startsWith(prefix) ? prefix + key : key
}

/**
 * @param {{
 *   keyPrefix: string,
 *   origin: string,
 *   path: string,
 *   method: string,
 *   id: string
 * }} parsedKey
 * @returns {string}
 */
function serializeMetadataKey (parsedKey) {
  const { keyPrefix, origin, path, method, id } = parsedKey

  const encodedOrigin = encodeURIComponent(origin)
  const encodedPath = encodeURIComponent(path)
  return `${keyPrefix}metadata:${encodedOrigin}:${encodedPath}:${method}:${id}`
}

/**
 * @param {string} key
 * @returns {{
 *   keyPrefix: string,
 *   origin: string,
 *   path: string,
 *   method: string,
 *   id: string
 * }}
 */
function parseMetadataKey (key) {
  const typePrefix = 'metadata:'
  const splitIndex = key.indexOf(typePrefix)

  if (splitIndex === -1) {
    throw new Error(`Invalid cache metadata key: "${key}"`)
  }

  const keyPrefix = key.slice(0, splitIndex)
  key = key.slice(splitIndex + typePrefix.length)

  const parts = key.split(':')
  const origin = decodeURIComponent(parts[0])
  const path = decodeURIComponent(parts[1])
  const method = parts[2]
  const id = parts[3]

  return { keyPrefix, origin, path, method, id }
}

/**
 * @param {{ keyPrefix: string, id: string }} parsedKey
 * @returns {string}
 */
function serializeIdKey (parsedKey) {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}ids:${id}`
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
 * @param {{ keyPrefix: string, id: string }} parsedKey
 * @returns {string}
 */
function serializeValueKey (parsedKey) {
  const { keyPrefix, id } = parsedKey
  return `${keyPrefix}values:${id}`
}

/**
 * @param {{ keyPrefix: string, tags: string[], id: string }} parsedKey
 * @returns {string}
 */
function serializeTagsKey (parsedKey) {
  const { keyPrefix, tags, id } = parsedKey
  return `${keyPrefix}cache-tags:${tags.sort().join(':')}:${id}`
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
  key = key.slice(splitIndex + typePrefix.length)

  const parts = key.split(':')
  const tags = parts.slice(0, -1)
  const id = parts[parts.length - 1]

  return { keyPrefix, tags, id }
}

module.exports = {
  addKeyPrefix,
  serializeMetadataKey,
  parseMetadataKey,
  serializeIdKey,
  parseIdKey,
  serializeValueKey,
  serializeTagsKey,
  parseTagsKey
}

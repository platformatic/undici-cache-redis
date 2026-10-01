// @ts-check
'use strict'

/**
 * @param {Record<string, string | string[]> | undefined} headers
 * @returns {Record<string, string | string[]>}
 */
function normalizeHeaders (headers) {
  const normalized = {}
  if (!headers) return normalized

  for (const name in headers) {
    normalized[name.toLowerCase()] = headers[name]
  }

  return normalized
}

/**
 * @param {Record<string, string | string[] | null | undefined> | undefined} vary
 * @param {Record<string, string | string[]>} headers lower-cased request headers
 * @returns {boolean}
 */
function varyMatches (vary, headers) {
  if (!vary) return true

  for (const header in vary) {
    const expected = vary[header]
    const actual = headers[header.toLowerCase()]

    if (expected === null || expected === undefined) {
      if (actual !== undefined) return false
    } else if (Array.isArray(expected) || Array.isArray(actual)) {
      if (JSON.stringify(expected) !== JSON.stringify(actual)) return false
    } else if (actual !== expected) {
      return false
    }
  }

  return true
}

module.exports = { normalizeHeaders, varyMatches }

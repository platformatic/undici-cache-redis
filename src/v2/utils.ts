import lruMap from 'lru_map'
import type { CacheKey } from '../types.ts'
import type { CacheIdentifier, Keys } from './types.ts'

export class KeysStorage {
  #serializedKeys: lruMap.LRUMap<string, Keys>

  constructor () {
    this.#serializedKeys = new lruMap.LRUMap<string, Keys>(1000)
  }

  get (key: Partial<CacheKey>, prefix: string): Keys {
    key ??= {}
    key.origin ??= ''
    key.path ??= ''
    key.method ??= ''

    if (prefix.length) {
      prefix += '|'
    }

    let id = key.id
    const keysCachedId = `${prefix}${key.id}`

    if (id && this.#serializedKeys.has(keysCachedId)) {
      return this.#serializedKeys.get(keysCachedId)!
    }

    id ??= '__PLACEHOLDER__'

    const serializedKey: Keys = {
      routes: `${prefix}routes`,
      tags: `${prefix}tags`,
      requests: `${prefix}requests|${key.origin}|${key.path}`,
      request: `${prefix}request|${key.origin}|${key.path}|${key.method}`,
      variants: `${prefix}variants|${key.origin}|${key.path}|${key.method}`,
      metadata: `${prefix}metadata|${id}`,
      body: `${prefix}body|${id}`
    }

    if (key.id) {
      this.#serializedKeys.set(keysCachedId, serializedKey)
    }

    return serializedKey
  }
}

export function serializeHeaders (
  headers: Record<string, string | string[] | null> | undefined
): Record<string, string> {
  // Get all entries and sort them by key
  const entries = Object.entries(headers ?? {}).sort((a, b) => a[0].localeCompare(b[0]))

  for (let i = 0; i < entries.length; i++) {
    // First of all, normalize the key as lowercase
    entries[i][0] = entries[i][0].toLowerCase()

    // Then, if the value is an array, convert it to a comma-separated string
    /* c8 ignore next 3 */
    if (Array.isArray(entries[i][1])) {
      entries[i][1] = (entries[i][1] as string[]).join(', ')
    }
  }

  // Retain all entries which have a value, then build a object back
  return Object.fromEntries(entries.filter(e => e[1])) as Record<string, string>
}

export function replaceKeyPlaceholder (key: string, id: string): string {
  return key.replace('__PLACEHOLDER__', id)
}

export function decodeBody (rawBody: string): Buffer[] {
  return rawBody.split(' ').map(chunk => Buffer.from(chunk, 'base64'))
}

export function varyMatches (entry: CacheIdentifier, headers: Record<string, string>) {
  // No vary, it is a match
  if (entry.specificity === 0) {
    return { value: entry.id }
  }

  // There is vary, check if it matches
  for (const [header, value] of Object.entries(entry.vary)) {
    if (headers[header] !== value) {
      return false
    }
  }

  return true
}

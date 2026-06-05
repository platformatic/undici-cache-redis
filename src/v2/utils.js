export function serializeHeaders (headers) {
  const entries = Object.entries(headers ?? {})
    .map(([name, value]) => {
      if (Array.isArray(value)) {
        value = value.join(', ')
      }

      return [name.toLowerCase(), value]
    })
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))

  return Object.fromEntries(entries)
}

export function serializeForHash (parts) {
  return JSON.stringify(parts)
}

export function encodeBodyChunk (chunk, encoding) {
  return (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).toString('base64')
}

export function decodeBody (body) {
  if (!body) {
    return []
  }
  return body.split(' ').filter(Boolean).map(chunk => Buffer.from(chunk, 'base64'))
}

export function varyMatches (entry, headers) {
  const vary = entry.vary ?? {}

  for (const [header, value] of Object.entries(vary)) {
    if ((headers[header] === undefined && value === null) || headers[header] === value) {
      continue
    }

    return false
  }

  return true
}

export function normalizePrefix (prefix) {
  if (!prefix) {
    return ''
  }
  return prefix.endsWith(':') ? prefix : `${prefix}:`
}

export function validateHashTagPart (name, value, allowEmpty) {
  if (value === undefined || value === null) {
    if (allowEmpty) {
      return ''
    }
    throw new TypeError(`${name} must be a non-empty string`)
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`)
  }

  if (!allowEmpty && value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }

  if (value.includes('{') || value.includes('}')) {
    throw new TypeError(`${name} cannot contain "{" or "}"`)
  }

  return value
}

export function normalizePrefixes (prefix, prefixes) {
  if (prefixes === undefined) {
    return [prefix]
  }

  if (!Array.isArray(prefixes)) {
    return [normalizePrefix(prefixes)]
  }

  return prefixes.map(normalizePrefix)
}

export function unique (values) {
  return Array.from(new Set(values))
}

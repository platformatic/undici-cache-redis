import { once } from 'node:events'
import { createServer } from 'node:http'
import { Client, interceptors } from 'undici'
import { RedisCache } from '../../../index.js'

export function cacheValue (opts = {}) {
  return {
    statusCode: 200,
    statusMessage: '',
    headers: opts.headers ?? {},
    vary: opts.vary,
    cachedAt: opts.cachedAt ?? Date.now(),
    staleAt: opts.staleAt ?? Date.now() + 10000,
    deleteAt: opts.deleteAt ?? Date.now() + 20000,
    cacheControlDirectives: opts.cacheControlDirectives ?? {}
  }
}

export async function writeEntry (cache, key, value, body) {
  const stream = cache.createWriteStream(key, value)
  if (Array.isArray(body)) {
    for (const chunk of body) {
      stream.write(chunk)
    }
    stream.end()
  } else {
    stream.end(body)
  }
  await once(stream, 'close')
}

export async function createCachedServer (t, opts = {}) {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    res.setHeader('cache-control', opts.cacheControl ?? 'public, s-maxage=100')
    if (opts.cacheTagsHeader && opts.cacheTags) {
      res.setHeader(opts.cacheTagsHeader, opts.cacheTags)
    }
    res.end(opts.body ?? 'asd')
  }).listen(0)

  await once(server, 'listening')

  const origin = `http://localhost:${server.address().port}`
  const store = new RedisCache({
    prefix: opts.prefix ?? `${crypto.randomUUID()}:`,
    tracking: opts.tracking ?? false,
    cacheTagsHeader: opts.cacheTagsHeader
  })
  const client = new Client(origin).compose(interceptors.cache({ store }))

  t.after(async () => {
    server.close()
    await client.close()
    await store.close()
  })

  return {
    client,
    origin,
    store,
    get requests () {
      return requests
    }
  }
}

'use strict'

// One "pod": a process with its own RedisCacheStore and tracking cache,
// driven by the parent test over IPC.

const { once } = require('node:events')
const RedisCacheStore = require('../../lib/redis-cache-store')

const store = new RedisCacheStore({
  clientOpts: { keyPrefix: process.env.KEY_PREFIX },
  cacheTagsHeader: 'cache-tag',
  errorCallback: (err) => process.send({ error: err.message })
})

const request = (path, headers = {}) => ({ origin: 'http://pods', method: 'GET', path, headers })

const operations = {
  async write ({ path, body, tags = [], vary, headers }) {
    const now = Date.now()
    const stream = store.createWriteStream(request(path, headers), {
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'cache-tag': tags.join(',') },
      vary,
      cachedAt: now,
      staleAt: now + 60_000,
      deleteAt: now + 60_000,
      cacheControlDirectives: {}
    })
    stream.end(Buffer.from(body))
    await once(stream, 'close')
  },

  async get ({ path, headers }) {
    const result = await store.get(request(path, headers))
    return result ? Buffer.concat(result.body).toString() : null
  },

  deleteTags: ({ tags }) => store.deleteTags(tags),

  delete: ({ path }) => store.delete(request(path)),

  // Reads `paths` in a loop until `until` and reports any version older than
  // the latest one the parent said was stored before the read started
  async readLoop ({ paths, until }) {
    const seen = { reads: 0, staleReads: 0, examples: [] }
    while (Date.now() < until) {
      // Yield like a server between requests. Lookups served from the
      // tracking cache only use microtasks and would starve IPC otherwise.
      await new Promise(resolve => setImmediate(resolve))
      await Promise.all(paths.map(async (path) => {
        const minimum = latest[path] ?? 0
        const body = await operations.get({ path })
        seen.reads++
        if (body !== null && Number(body) < minimum) {
          seen.staleReads++
          if (seen.examples.length < 5) seen.examples.push({ path, body, minimum })
        }
      }))
    }
    return seen
  },

  // The parent tells every pod which version is stored and propagated
  stored ({ path, version }) {
    latest[path] = version
  },

  close: () => store.close()
}

const latest = {}

process.on('message', async ({ id, op, args }) => {
  try {
    process.send({ id, result: await operations[op](args) })
  } catch (err) {
    process.send({ id, error: err.message })
  }
  if (op === 'close') process.exit(0)
})

process.send({ ready: true })

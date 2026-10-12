'use strict'

const { test } = require('node:test')
const { strictEqual } = require('node:assert')
const { once } = require('node:events')
const { RedisCacheStore } = require('../../index.js')

test('URL TLS and credentials work on all discovered shards', { skip: !process.env.TLS_CLUSTER_URL }, async (t) => {
  // Trust the ephemeral CA via NODE_EXTRA_CA_CERTS. No explicit TLS option:
  // rediss:// must enable encryption and preserve certificate verification.
  const store = new RedisCacheStore({
    clusterUrl: process.env.TLS_CLUSTER_URL,
    keyPrefix: 'secure-cluster-test:',
    cacheTagsHeader: 'cache-tags',
    errorCallback: err => { throw err }
  })
  t.after(() => store.close())
  const requests = Array.from({ length: 50 }, (_, i) => ({
    id: `explicit-${i}`, origin: 'http://secure-cluster.local', method: 'GET', path: `/item/${i}`, headers: {}
  }))
  for (const key of requests) {
    const now = Date.now()
    const stream = store.createWriteStream(key, {
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'cache-tags': 'secure' },
      cachedAt: now,
      staleAt: now + 60_000,
      deleteAt: now + 60_000
    })
    stream.end(Buffer.from(key.path))
    await once(stream, 'close')
  }
  for (const key of requests) {
    strictEqual(Buffer.concat((await store.get(key)).body).toString(), key.path)
  }
  await store.deleteTags(['secure'])
  for (const key of requests) strictEqual(await store.get(key), undefined)
})

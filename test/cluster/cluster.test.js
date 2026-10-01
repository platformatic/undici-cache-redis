'use strict'

// Runs against the valkey-cluster service of docker-compose.yml:
//   npm run valkey && npm run test:cluster

const { test, before, beforeEach, after } = require('node:test')
const { strictEqual, deepStrictEqual, ok } = require('node:assert')
const { once } = require('node:events')
const { Cluster } = require('iovalkey')
const { RedisCacheStore } = require('../../index.js')

const CLUSTER_URL = process.env.CLUSTER_URL ?? 'redis://127.0.0.1:7000'
const ORIGIN = 'http://cluster.local'

let cluster

before(async () => {
  cluster = new Cluster([CLUSTER_URL])
  await once(cluster, 'ready')
})

beforeEach(async () => {
  await Promise.all(cluster.nodes('master').map(node => node.flushall()))
})

after(() => cluster.quit())

function createStore (opts) {
  return new RedisCacheStore({
    clusterUrl: CLUSTER_URL,
    keyPrefix: 'cluster-test:',
    cacheTagsHeader: 'cache-tags',
    errorCallback: (err) => { throw err },
    ...opts
  })
}

async function write (store, path, { vary, tags = [], body = path } = {}) {
  const now = Date.now()
  const stream = store.createWriteStream({ origin: ORIGIN, method: 'GET', path, headers: {} }, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'cache-tags': tags.join(',') },
    vary,
    cachedAt: now,
    staleAt: now + 60_000,
    deleteAt: now + 60_000,
    cacheControlDirectives: {}
  })
  stream.end(Buffer.from(body))
  await once(stream, 'close')
}

async function read (store, path, headers = {}) {
  const result = await store.get({ origin: ORIGIN, method: 'GET', path, headers })
  return result && Buffer.concat(result.body).toString()
}

const paths = Array.from({ length: 50 }, (_, i) => `/item/${i}`)

test('stores and finds responses on every shard', async (t) => {
  const store = createStore()
  t.after(() => store.close())

  await Promise.all(paths.map(path => write(store, path)))
  for (const path of paths) {
    strictEqual(await read(store, path), path)
  }

  const keysPerMaster = await Promise.all(cluster.nodes('master').map(node => node.dbsize()))
  strictEqual(keysPerMaster.length, 3)
  ok(keysPerMaster.every(count => count > 0), `keys per master: ${keysPerMaster}`)
})

test('deletes by key and by URL', async (t) => {
  const store = createStore()
  t.after(() => store.close())

  await write(store, '/a')
  await write(store, '/b')
  await write(store, '/b', { vary: { 'accept-language': 'en' }, body: 'en' })

  await store.deleteKeys([{ origin: ORIGIN, method: 'GET', path: '/a' }])
  strictEqual(await read(store, '/a'), undefined)
  strictEqual(await read(store, '/b'), '/b')

  await store.delete({ origin: ORIGIN, method: 'GET', path: '/b' })
  strictEqual(await read(store, '/b'), undefined)
  strictEqual(await read(store, '/b', { 'accept-language': 'en' }), undefined)
})

test('invalidates tags spread over every shard', async (t) => {
  const store = createStore()
  t.after(() => store.close())

  await Promise.all(paths.map((path, i) => write(store, path, { tags: ['all', i % 2 ? 'odd' : 'even'] })))
  await write(store, '/untagged')

  await store.deleteTags(['odd'])
  for (const [i, path] of paths.entries()) {
    strictEqual(await read(store, path), i % 2 ? undefined : path)
  }

  await store.deleteTags([['all', 'even']])
  for (const path of paths) {
    strictEqual(await read(store, path), undefined)
  }
  strictEqual(await read(store, '/untagged'), '/untagged')
})

test('uses an existing cluster client and does not close it', async (t) => {
  const client = new Cluster([CLUSTER_URL])
  t.after(() => client.quit())

  const store = new RedisCacheStore({ client, cacheTagsHeader: 'cache-tags' })
  await write(store, '/existing', { tags: ['tag'] })
  strictEqual(await read(store, '/existing'), '/existing')

  await store.deleteTags(['tag'])
  strictEqual(await read(store, '/existing'), undefined)

  await store.close()
  deepStrictEqual(await client.ping(), 'PONG')
})

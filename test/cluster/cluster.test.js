'use strict'

// Runs against the valkey-cluster service of docker-compose.yml:
//   npm run valkey && npm run test:cluster

const { test, before, beforeEach, after } = require('node:test')
const { strictEqual, deepStrictEqual, ok } = require('node:assert')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { Cluster } = require('iovalkey')
const { RedisCacheStore } = require('../../index.js')
const { indexKey } = require('../../lib/keys.js')

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

test('keeps atomic entry scripts working after a live slot migration', async (t) => {
  const store = createStore()
  t.after(() => store.close())
  await write(store, '/migrated', { tags: ['move'] })
  const slot = await cluster.cluster('KEYSLOT', indexKey('cluster-test:', { origin: ORIGIN, path: '/migrated' }))
  const slots = await cluster.cluster('SLOTS')
  const owner = slots.find(([start, end]) => slot >= start && slot <= end)[2]
  const source = cluster.nodes('master').find(node => Number(node.options.port) === owner[1])
  const destination = cluster.nodes('master').find(node => node !== source)
  const sourceId = await source.cluster('MYID')
  const destinationId = await destination.cluster('MYID')
  await destination.cluster('SETSLOT', slot, 'IMPORTING', sourceId)
  await source.cluster('SETSLOT', slot, 'MIGRATING', destinationId)
  for (;;) {
    const keys = await source.cluster('GETKEYSINSLOT', slot, 100)
    if (!keys.length) break
    await source.call('MIGRATE', '127.0.0.1', destination.options.port, '', 0, 5000, 'KEYS', ...keys)
  }
  await Promise.all(cluster.nodes('master').map(node => node.cluster('SETSLOT', slot, 'NODE', destinationId)))
  strictEqual(await read(store, '/migrated'), '/migrated')
  await write(store, '/migrated', { tags: ['move'], body: 'after move' })
  strictEqual(await read(store, '/migrated'), 'after move')
  await store.deleteTags(['move'])
  strictEqual(await read(store, '/migrated'), undefined)
})

test('keeps cached entries and invalidation working after replica promotion', async (t) => {
  await new Promise((resolve, reject) => cluster.refreshSlotsCache(err => err ? reject(err) : resolve()))
  let replica = cluster.nodes('slave')[0]
  const discoveryDeadline = Date.now() + 15000
  while (!replica && process.env.CLUSTER_REQUIRE_REPLICAS === '1') {
    ok(Date.now() < discoveryDeadline, 'configured replicas were not discovered')
    await sleep(100)
    await new Promise((resolve, reject) => cluster.refreshSlotsCache(err => err ? reject(err) : resolve()))
    replica = cluster.nodes('slave')[0]
  }
  if (!replica) return t.skip('cluster has no replicas; compose uses three replicas')
  const store = createStore()
  t.after(() => store.close())
  await Promise.all(paths.map(path => write(store, path, { tags: ['failover'] })))
  for (const master of cluster.nodes('master')) ok(await master.call('WAIT', 1, 5000) >= 1)
  await replica.cluster('FAILOVER')
  const deadline = Date.now() + 15000
  while ((await replica.call('ROLE'))[0] !== 'master') {
    ok(Date.now() < deadline, 'replica promotion timed out')
    await sleep(100)
  }
  await new Promise((resolve, reject) => cluster.refreshSlotsCache(err => err ? reject(err) : resolve()))
  for (const path of paths) strictEqual(await read(store, path), path)
  await store.deleteTags(['failover'])
  for (const path of paths) strictEqual(await read(store, path), undefined)
})

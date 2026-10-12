'use strict'

// Multi-pod benchmark: several processes, each with its own store and
// tracking cache, share one server and the same hot URLs, like the replicas
// of a deployment. Prints one JSON line per workload and hit ratio.
//
//   node benchmarks/pods.js [--host localhost] [--pods 4] [--concurrency 16]
//     [--duration 4] [--noise 100000] [--ratios 0.2,0.45,0.75,0.95]
//     [--workloads longtail,refresh,uncacheable] [--tracking on|off] [--lib path/to/another/version]
//
// Workloads, by what a request that is not a hit does:
//   longtail     a new URL of this pod, fetched and cached
//   refresh      a hot URL shared by every pod changed, and is cached again
//   uncacheable  a URL shared by every pod whose responses are never cached

const { parseArgs } = require('node:util')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { resolve } = require('node:path')
const { Redis } = require('iovalkey')

const { values: args } = parseArgs({
  options: {
    lib: { type: 'string', default: resolve(__dirname, '..') },
    host: { type: 'string', default: 'localhost' },
    pods: { type: 'string', default: '4' },
    concurrency: { type: 'string', default: '16' },
    duration: { type: 'string', default: '4' },
    noise: { type: 'string', default: '100000' },
    keys: { type: 'string', default: '1000' },
    ratios: { type: 'string', default: '0.2,0.45,0.75,0.95' },
    workloads: { type: 'string', default: 'longtail,refresh,uncacheable' },
    tracking: { type: 'string', default: 'on' },
    worker: { type: 'boolean', default: false },
    pod: { type: 'string', default: '0' }
  }
})

const KEYS = Number(args.keys)
const BODY = Buffer.alloc(2048, 'x')
const ORIGIN = 'http://bench.local'

const cacheKey = (path, i) => ({
  origin: ORIGIN,
  method: 'GET',
  path,
  headers: i % 2 === 0 ? { 'accept-encoding': 'gzip', 'user-agent': 'bench' } : { 'user-agent': 'bench' }
})

function cachedValue (i) {
  const now = Date.now()
  return {
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'cache-tags': `t${i % 10},all` },
    vary: i % 2 === 0 ? { 'accept-encoding': 'gzip' } : undefined,
    cachedAt: now,
    staleAt: now + 600_000,
    deleteAt: now + 600_000,
    cacheControlDirectives: {}
  }
}

async function write (store, path, i) {
  const stream = store.createWriteStream(cacheKey(path, i), cachedValue(i))
  stream.end(BODY)
  await once(stream, 'finish')
}

function loadStore () {
  const lib = require(resolve(args.lib, 'index.js'))
  return lib.RedisCacheStore ?? lib
}

// A store whose commands are attributed to the lookup that sent them, to
// know which lookups were answered from the pod's own memory
async function createCountingStore (RedisCacheStore, requestContext) {
  let sent = 0
  const redis = new Redis({ host: args.host, enableAutoPipelining: true })
  const client = new Proxy(redis, {
    get (target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      return (...commandArgs) => {
        sent++
        const context = requestContext.getStore()
        if (context) context.commands++
        return value.apply(target, commandArgs)
      }
    }
  })

  const opts = { tracking: args.tracking === 'on', cacheTagsHeader: 'cache-tags', errorCallback: () => {} }
  // clientOpts too: some versions connect their tracking subscriber with it
  const store = new RedisCacheStore({ ...opts, client, clientOpts: { host: args.host } })
  await store.get(cacheKey('/probe', 0))
  if (sent > 0) return { store, countsCommands: true }

  // This version doesn't support `client`
  await store.close().catch(() => {})
  redis.disconnect()
  return { store: new RedisCacheStore({ ...opts, clientOpts: { host: args.host } }), countsCommands: false }
}

async function worker () {
  const pod = Number(args.pod)
  const requestContext = new AsyncLocalStorage()
  const { store, countsCommands } = await createCountingStore(loadStore(), requestContext)

  // Let tracking start
  await new Promise(resolve => setTimeout(resolve, 300))
  process.send({ ready: true })

  let fresh = 0
  const workloads = {
    longtail: async () => {
      const path = `/new/${pod}/${fresh++}`
      if (!await store.get(cacheKey(path, fresh))) await write(store, path, fresh)
    },
    refresh: async () => {
      const n = Math.floor(Math.random() * KEYS)
      await write(store, `/item/${n}`, n)
    },
    uncacheable: (i) => store.get(cacheKey(`/uncacheable/${i % KEYS}`, i))
  }

  process.on('message', async ({ workload, ratio, until }) => {
    const latencies = []
    let ops = 0
    let hits = 0
    let lookups = 0
    let localLookups = 0

    await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
      while (Date.now() < until) {
        const i = ops++
        const start = process.hrtime.bigint()
        if (Math.random() < ratio) {
          const context = { commands: 0 }
          const n = i % KEYS
          const result = await requestContext.run(context, () => store.get(cacheKey(`/item/${n}`, n)))
          lookups++
          if (result) hits++
          if (context.commands === 0) localLookups++
        } else {
          await workloads[workload](i).catch(() => {})
        }
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6)
        // Yield like a server between requests: lookups answered from memory
        // only use microtasks
        if (i % 16 === 0) await new Promise(resolve => setImmediate(resolve))
      }
    }))

    process.send({ ops, hits, lookups, localLookups: countsCommands ? localLookups : null, latencies })
  })
}

async function coordinator () {
  const admin = new Redis({ host: args.host })
  await admin.flushall()
  for (let i = 0; i < Number(args.noise); i += 10_000) {
    await Promise.all(Array.from({ length: Math.min(10_000, Number(args.noise) - i) }, (_, j) => admin.set(`noise:${i + j}`, 'x')))
  }

  // The hot URLs every pod requests
  const RedisCacheStore = loadStore()
  const seeder = new RedisCacheStore({ clientOpts: { host: args.host }, tracking: false, cacheTagsHeader: 'cache-tags', errorCallback: () => {} })
  for (let i = 0; i < KEYS; i += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, j) => write(seeder, `/item/${i + j}`, i + j)))
  }
  await seeder.close()

  const pods = Array.from({ length: Number(args.pods) }, (_, pod) =>
    fork(__filename, [...process.argv.slice(2), '--worker', '--pod', String(pod)], { execArgv: ['--max-old-space-size=4096'] }))
  // A crashed pod ends the run with an error line instead of a hang
  const crashed = new Promise(resolve => {
    for (const pod of pods) pod.once('exit', (code, signal) => resolve(`pod exited (code ${code}, signal ${signal})`))
  })
  await Promise.all(pods.map(pod => once(pod, 'message')))

  const commandCalls = async () => {
    const stats = await admin.info('commandstats')
    let total = 0
    for (const [, name, calls] of stats.matchAll(/cmdstat_([a-z|]+):calls=(\d+)/g)) {
      if (name !== 'info' && name !== 'flushall') total += Number(calls)
    }
    return total
  }

  const duration = Number(args.duration) * 1000
  for (const workload of args.workloads.split(',')) {
    for (const ratio of args.ratios.split(',').map(Number)) {
      const before = await commandCalls()
      const until = Date.now() + duration
      const results = await Promise.race([
        Promise.all(pods.map(async (pod) => {
          pod.send({ workload, ratio, until })
          const [result] = await once(pod, 'message')
          return result
        })),
        crashed
      ])
      if (typeof results === 'string') {
        console.log(JSON.stringify({ workload, ratio, error: results }))
        for (const pod of pods) pod.kill()
        process.exit(0)
      }
      const calls = await commandCalls() - before

      const sum = (key) => results.reduce((total, result) => total + result[key], 0)
      const ops = sum('ops')
      const latencies = results.flatMap(result => result.latencies).sort((a, b) => a - b)
      console.log(JSON.stringify({
        workload,
        ratio,
        ops: Math.round(ops / (duration / 1000)),
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p99: latencies[Math.floor(latencies.length * 0.99)],
        hitRatio: sum('hits') / ops,
        lookupHitRatio: sum('hits') / sum('lookups'),
        localLookupRatio: results.every(result => result.localLookups !== null) ? sum('localLookups') / sum('lookups') : null,
        commandsPerRequest: calls / ops
      }))
    }
  }

  for (const pod of pods) pod.kill()
  await admin.quit()
}

(args.worker ? worker() : coordinator()).catch((err) => {
  console.error(err)
  process.exit(1)
})

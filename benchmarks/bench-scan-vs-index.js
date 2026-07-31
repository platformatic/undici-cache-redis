import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { Redis } from 'iovalkey'
import { RedisCache, RedisCacheStore } from '../index.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const UNRELATED_KEYS = Number(process.env.UNRELATED_KEYS ?? 50000)
const LOOKUPS = Number(process.env.LOOKUPS ?? 500)
const VARIANTS = Number(process.env.VARIANTS ?? 8)

async function writeEntry (store, key, value, body) {
  const stream = store.createWriteStream(key, value)
  stream.end(body)
  await once(stream, 'close')
}

function percentile (values, p) {
  return values[Math.floor((values.length - 1) * p)]
}

async function timeLookups (store, key) {
  const timings = []

  for (let i = 0; i < LOOKUPS; i++) {
    const start = performance.now()
    await store.get(key)
    timings.push(performance.now() - start)
  }

  timings.sort((a, b) => a - b)
  return {
    avg: timings.reduce((acc, value) => acc + value, 0) / timings.length,
    p50: percentile(timings, 0.50),
    p95: percentile(timings, 0.95),
    p99: percentile(timings, 0.99)
  }
}

async function seedUnrelatedKeys (redis) {
  const pipeline = redis.pipeline()
  for (let i = 0; i < UNRELATED_KEYS; i++) {
    pipeline.set(`bench:unrelated:${i}`, i)
  }
  await pipeline.exec()
}

async function seedCache (store, prefix) {
  const value = {
    statusCode: 200,
    statusMessage: '',
    headers: {},
    cachedAt: Date.now(),
    staleAt: Date.now() + 60_000,
    deleteAt: Date.now() + 120_000,
    cacheControlDirectives: {}
  }

  for (let i = 0; i < VARIANTS; i++) {
    await writeEntry(
      store,
      {
        origin: 'https://example.com',
        method: 'GET',
        path: '/bench',
        headers: { vary: `${prefix}-${i}` }
      },
      {
        ...value,
        vary: { vary: `${prefix}-${i}` }
      },
      `${prefix}-${i}`
    )
  }
}

async function main () {
  const redis = new Redis(REDIS_URL)
  await redis.flushall()
  await seedUnrelatedKeys(redis)
  await redis.quit()

  const v1 = new RedisCacheStore({ tracking: false, clientOpts: { keyPrefix: 'bench:v1:' } })
  const v2 = new RedisCache({ tracking: false, prefix: 'bench:v2:' })

  try {
    await seedCache(v1, 'v1')
    await seedCache(v2, 'v2')

    const v1Key = {
      origin: 'https://example.com',
      method: 'GET',
      path: '/bench',
      headers: { vary: `v1-${VARIANTS - 1}` }
    }
    const v2Key = {
      origin: 'https://example.com',
      method: 'GET',
      path: '/bench',
      headers: { vary: `v2-${VARIANTS - 1}` }
    }

    await v1.get(v1Key)
    await v2.get(v2Key)

    const v1Results = await timeLookups(v1, v1Key)
    const v2Results = await timeLookups(v2, v2Key)

    console.log(JSON.stringify({
      unrelatedKeys: UNRELATED_KEYS,
      variants: VARIANTS,
      lookups: LOOKUPS,
      v1: v1Results,
      v2: v2Results
    }, null, 2))
  } finally {
    await v1.close()
    await v2.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})

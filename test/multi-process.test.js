'use strict'

// Several processes ("pods") with tracking enabled share one server, as in a
// deployment with multiple replicas. Writes, rewrites and purges done by one
// pod must reach the tracking cache of every other pod.

const { test, before, after } = require('node:test')
const { strictEqual, deepStrictEqual, ok } = require('node:assert')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { join } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { cleanValkey } = require('./helper.js')

// How long an invalidation may take to reach the other pods
const PROPAGATION = 300

const pods = []

function startPod (keyPrefix) {
  const child = fork(join(__dirname, '__fixtures__', 'pod.js'), { env: { ...process.env, KEY_PREFIX: keyPrefix } })
  const pending = new Map()
  const errors = []
  let nextId = 0

  child.on('message', (message) => {
    if (message.id === undefined) {
      if (message.error) errors.push(message.error)
      return
    }
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error))
    else resolve(message.result)
  })

  const call = (op, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.send({ id, op, args })
  })

  return { child, call, errors, ready: once(child, 'message') }
}

/**
 * Polls until every pod returns `expected`, and returns how long it took
 */
async function waitForAll (read, expected) {
  const start = Date.now()
  while (true) {
    const bodies = await Promise.all(pods.map(read))
    if (bodies.every(body => body === expected)) return Date.now() - start
    if (Date.now() - start > PROPAGATION * 10) {
      deepStrictEqual(bodies, pods.map(() => expected))
    }
    await sleep(10)
  }
}

before(async () => {
  await cleanValkey()
  const keyPrefix = `${crypto.randomUUID()}:`
  for (let i = 0; i < 3; i++) pods.push(startPod(keyPrefix))
  await Promise.all(pods.map(pod => pod.ready))
  // Wait for tracking to be enabled in every pod
  await sleep(200)
})

after(async () => {
  await Promise.all(pods.map(pod => pod.call('close').catch(() => {})))
  for (const pod of pods) deepStrictEqual(pod.errors, [])
})

test('a response cached by one pod is found by the others after they missed', async () => {
  for (const pod of pods) strictEqual(await pod.call('get', { path: '/new' }), null)

  await pods[0].call('write', { path: '/new', body: 'v1' })

  const elapsed = await waitForAll(pod => pod.call('get', { path: '/new' }), 'v1')
  ok(elapsed <= PROPAGATION, `took ${elapsed}ms`)
})

test('a rewrite by one pod replaces the response cached by the others', async () => {
  await pods[0].call('write', { path: '/rewrite', body: 'v1' })
  await waitForAll(pod => pod.call('get', { path: '/rewrite' }), 'v1')
  // Read again, so that every pod serves it from its tracking cache
  await waitForAll(pod => pod.call('get', { path: '/rewrite' }), 'v1')

  await pods[1].call('write', { path: '/rewrite', body: 'v2' })

  const elapsed = await waitForAll(pod => pod.call('get', { path: '/rewrite' }), 'v2')
  ok(elapsed <= PROPAGATION, `took ${elapsed}ms`)
})

test('a more specific variant written by one pod is used by the others', async () => {
  const headers = { 'accept-language': 'en' }
  await pods[0].call('write', { path: '/vary', body: 'generic' })
  await waitForAll(pod => pod.call('get', { path: '/vary', headers }), 'generic')

  await pods[2].call('write', { path: '/vary', body: 'en', vary: headers, headers })

  const elapsed = await waitForAll(pod => pod.call('get', { path: '/vary', headers }), 'en')
  ok(elapsed <= PROPAGATION, `took ${elapsed}ms`)
})

test('a purge by one pod removes the response from every pod', async () => {
  await pods[0].call('write', { path: '/purge/a', body: 'a', tags: ['purge'] })
  await pods[1].call('write', { path: '/purge/b', body: 'b', tags: ['purge'] })
  await waitForAll(pod => pod.call('get', { path: '/purge/a' }), 'a')
  await waitForAll(pod => pod.call('get', { path: '/purge/b' }), 'b')

  await pods[2].call('deleteTags', { tags: ['purge'] })

  const elapsed = Math.max(
    await waitForAll(pod => pod.call('get', { path: '/purge/a' }), null),
    await waitForAll(pod => pod.call('get', { path: '/purge/b' }), null)
  )
  ok(elapsed <= PROPAGATION, `took ${elapsed}ms`)
})

test('pods never serve a stale version once a rewrite has propagated', async () => {
  const paths = Array.from({ length: 20 }, (_, i) => `/hot/${i}`)
  for (const path of paths) await pods[0].call('write', { path, body: '0' })

  // Every pod reads the hot URLs in a loop while they are rewritten by
  // different pods. After each version is stored and given time to propagate,
  // every pod is told it must not return anything older.
  const until = Date.now() + 3000
  const reading = Promise.all(pods.map(pod => pod.call('readLoop', { paths, until })))

  let version = 0
  while (Date.now() < until - PROPAGATION * 2) {
    version++
    const writer = pods[version % pods.length]
    await Promise.all(paths.map(path => writer.call('write', { path, body: String(version) })))
    await sleep(PROPAGATION)
    await Promise.all(pods.flatMap(pod => paths.map(path => pod.call('stored', { path, version }))))
  }

  const results = await reading
  ok(version >= 3, `only ${version} versions were written`)
  for (const result of results) {
    ok(result.reads > 0)
    deepStrictEqual({ staleReads: result.staleReads, examples: result.examples }, { staleReads: 0, examples: [] })
  }
})

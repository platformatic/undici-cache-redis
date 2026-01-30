import { equal, fail, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, interceptors } from 'undici'
import { createStore, preparePrefix, setVersion } from '../helper.ts'

setVersion('1.0.0')

for (const maxAgeHeader of ['s-maxage', 'max-age']) {
  test(`stale-while-revalidate w/ ${maxAgeHeader}`, async t => {
    const prefix = await preparePrefix(t)
    const store = await createStore(t, { prefix })

    let requestsToOrigin = 0
    let revalidationRequests = 0
    const server = createServer((req, res) => {
      if (req.headers['if-none-match']) {
        revalidationRequests++
        if (req.headers['if-none-match'] !== '"asd"') {
          fail(`etag mismatch: ${req.headers['if-none-match']}`)
        }

        res.statusCode = 304
        res.end()
      } else {
        requestsToOrigin++
        res.setHeader('cache-control', `public, ${maxAgeHeader}=2, stale-while-revalidate=4`)
        res.setHeader('etag', '"asd"')
        res.end('asd')
      }
    }).listen(0)

    const client = new Client(`http://localhost:${(server.address() as AddressInfo).port}`).compose(
      interceptors.cache({
        store
      })
    )

    t.after(async () => {
      server.close()
      await client.close()
      await store.close()
    })

    await once(server, 'listening')

    strictEqual(requestsToOrigin, 0)
    strictEqual(revalidationRequests, 0)

    const writePromise = once(store, 'write')
    // Send first request, this will hit the origin
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      equal(requestsToOrigin, 1)

      // Wait for revalidation to happen
      await sleep(500)

      strictEqual(revalidationRequests, 0)
      equal(response.statusCode, 200)
      equal(await response.body.text(), 'asd')
    }

    // We need to sleep for a bit to let the cache entry
    // be saved in Valkey
    await writePromise

    // Send second request, this will be cached.
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      equal(requestsToOrigin, 1)

      // Wait for revalidation to happen
      await sleep(500)

      strictEqual(revalidationRequests, 0)
      equal(response.statusCode, 200)
      equal(await response.body.text(), 'asd')
    }

    await sleep(2500)

    // Send third request, this should be revalidated
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      equal(requestsToOrigin, 1)

      // Wait for revalidation to happen
      await sleep(500)

      strictEqual(revalidationRequests, 1)
      equal(response.statusCode, 200)
      equal(await response.body.text(), 'asd')
    }

    await sleep(6000)

    // Send fourth request, this should be a new request entirely
    {
      const response = await client.request({
        origin: 'localhost',
        path: '/',
        method: 'GET'
      })
      equal(requestsToOrigin, 2)

      // Wait for revalidation to happen
      await sleep(500)

      strictEqual(revalidationRequests, 1)
      equal(response.statusCode, 200)
      equal(await response.body.text(), 'asd')
    }
  })
}

test('stale-if-error from response works as expected', async t => {
  const prefix = await preparePrefix(t)
  const store = await createStore(t, { prefix })

  let requestsToOrigin = 0
  const server = createServer((_, res) => {
    requestsToOrigin++
    if (requestsToOrigin === 1) {
      // First request
      res.setHeader('cache-control', 'public, s-maxage=4, stale-if-error=4')
      res.end('asd')
    } else {
      res.statusCode = 500
      res.end('')
    }
  }).listen(0)

  const client = new Client(`http://localhost:${(server.address() as AddressInfo).port}`).compose(
    interceptors.cache({ store })
  )

  t.after(async () => {
    server.close()
    await client.close()
    await store.close()
  })

  await once(server, 'listening')

  strictEqual(requestsToOrigin, 0)

  // Send first request. This will hit the origin and succeed
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    equal(requestsToOrigin, 1)
    equal(response.statusCode, 200)
    equal(await response.body.text(), 'asd')
  }

  await once(store, 'write')

  // Send second request. It isn't stale yet, so this should be from the
  //  cache and succeed
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    equal(requestsToOrigin, 1)
    equal(response.statusCode, 200)
    equal(await response.body.text(), 'asd')
  }

  await sleep(5000)

  // Send third request. This is now stale, the revalidation request should
  //  fail but the response should still be served from cache.
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    equal(requestsToOrigin, 2)
    equal(response.statusCode, 200)
    equal(await response.body.text(), 'asd')
  }

  await sleep(5000)

  // Send fourth request. We're now outside the stale-if-error threshold and
  //  should see the error.
  {
    const response = await client.request({
      origin: 'localhost',
      path: '/',
      method: 'GET'
    })
    equal(requestsToOrigin, 3)
    equal(response.statusCode, 500)
  }
})

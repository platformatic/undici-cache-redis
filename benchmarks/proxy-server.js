'use strict'

const fastify = require('fastify')
const { Agent, interceptors } = require('undici')
const { RedisCacheStore } = require('../index.js')

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000'
const PORT = process.env.PROXY_PORT || 3001
const CACHE_TYPE = process.env.CACHE_TYPE || 'none' // none, memory, redis

const app = fastify()

let agent

const createAgent = () => {
  switch (CACHE_TYPE) {
    case 'redis-tracking': {
      const redisCacheStore = new RedisCacheStore({
        clientOpts: {
          host: 'localhost',
          port: 6379
        },
        cacheTagsHeader: 'Cache-Tags',
        tracking: true,
        maxSize: 200 * 1024 * 1024, // 200MB
        maxCount: 10000
      })
      return new Agent().compose(interceptors.cache({
        store: redisCacheStore,
        methods: ['GET']
      }))
    }
    case 'redis-only': {
      const redisCacheStore = new RedisCacheStore({
        clientOpts: {
          host: 'localhost',
          port: 6379
        },
        cacheTagsHeader: 'Cache-Tags',
        tracking: false,
      })
      return new Agent().compose(interceptors.cache({
        store: redisCacheStore,
        methods: ['GET']
      }))
    }
    case 'memory': {
      // Simple in-memory cache using interceptors.cache with built-in memory store
      return new Agent().compose(interceptors.cache({ methods: ['GET'] }))
    }
    default:
      // No cache
      return new Agent()
  }
}

// Proxy all requests to backend
app.route({
  method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  url: '/*',
  handler: async (request, reply) => {
    try {
      const { method, url, headers, body } = request

      // Forward request to backend
      const startTime = Date.now()
      const response = await agent.request({
        origin: BACKEND_URL,
        method,
        path: url,
        headers: {
          ...headers,
          host: undefined // Remove host header
        },
        body
      })
      const duration = Date.now() - startTime

      // Add cache hit header for debugging
      // Cache hits are indicated by the presence of an 'age' header
      const cacheHit = response.headers.age !== undefined
      if (cacheHit) {
        reply.header('x-proxy-cache', 'HIT')
        console.log(`CACHE HIT: ${method} ${url} (${duration}ms, age: ${response.headers.age}s)`)
      } else {
        reply.header('x-proxy-cache', 'MISS')
        console.log(`CACHE MISS: ${method} ${url} (${duration}ms)`)
      }

      // Forward status code
      reply.code(response.statusCode)

      // Forward headers
      Object.entries(response.headers).forEach(([key, value]) => {
        reply.header(key, value)
      })

      // Return body
      return response.body
    } catch (error) {
      reply.code(500)
      return { error: 'Proxy error', message: error.message }
    }
  }
})

const start = async () => {
  try {
    console.log(`[${CACHE_TYPE.toUpperCase()}] Creating agent...`)
    agent = createAgent()
    console.log(`[${CACHE_TYPE.toUpperCase()}] Starting proxy server on port ${PORT}...`)
    await app.listen({ port: PORT, host: '0.0.0.0' })
    console.log(`[${CACHE_TYPE.toUpperCase()}] Proxy server listening on http://0.0.0.0:${PORT}`)
  } catch (err) {
    console.error(`[${CACHE_TYPE.toUpperCase()}] Server startup error:`, err)
    process.exit(1)
  }
}

start()

# Undici Redis Cache Example

This example demonstrates a production-ready implementation of `@platformatic/undici-cache-redis`, showcasing HTTP response caching with Redis/Valkey backend.

## Features Demonstrated

- **HTTP Response Caching**: Automatic caching of GET requests
- **Cache Tags**: Tag-based cache invalidation for related resources
- **Performance Tracking**: Real-time monitoring of cache hits/misses and latency improvements
- **Client-Side Tracking**: Redis client-side caching for reduced round trips
- **Cache Management**: Administrative operations for cache inspection and invalidation
- **Error Handling**: Robust error handling and logging

## Architecture

```
┌─────────────┐     HTTP      ┌─────────────┐     Cache      ┌─────────────┐
│   Client    │ ──────────▶   │   Undici    │ ◀────────────▶ │    Redis    │
│ Application │               │ + Cache     │                 │   (Valkey)  │
└─────────────┘               │ Interceptor │                 └─────────────┘
                              └─────────────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │   Fastify   │
                              │ API Server  │
                              └─────────────┘
```

## Prerequisites

- Node.js >= 18.0.0
- Redis/Valkey running locally (default port 6379)

## Setup

1. Install dependencies from the root directory:
```bash
npm install
```

2. Ensure Redis/Valkey is running:
```bash
# If you have Redis/Valkey installed locally:
redis-server

# Or using the project's Docker setup from root directory:
npm run valkey
```

3. Start the API server:
```bash
node server.js
```

4. In another terminal, run the client demonstration:
```bash
node client.js
```

## Available Examples

### Basic Example (`client.js`)
Demonstrates basic caching functionality with performance tracking:
- Cache hits and misses
- Tag-based invalidation 
- Performance comparison
- Works with both `agent.request()` and `fetch()`

### Advanced Example (`advanced-client.js`)
Shows advanced caching patterns:
- Cache stampede protection
- Conditional caching logic
- Cache warming strategies
- Analytics and monitoring

### Cache Manager Example (`cache-manager-example.js`)
Focuses on advanced cache management with `RedisCacheManager`:
- Real-time cache event monitoring
- Cache analysis and reporting
- Selective cache invalidation by tags
- Cache entry inspection and debugging
- Programmatic cache cleanup patterns

Run any example:
```bash
node client.js
node advanced-client.js
node cache-manager-example.js
```

## What the Example Shows

### 1. Initial Requests (Cache Misses)
The client makes several API requests that are not yet cached. You'll see higher latencies as requests go to the origin server.

### 2. Cached Responses (Cache Hits)
Subsequent identical requests are served from Redis cache, showing dramatic latency improvements (often 10-100x faster).

### 3. Cache Tag Invalidation
Demonstrates bulk cache invalidation using tags. When invalidating the "products" tag, all product-related cache entries are removed.

### 4. Automatic Cache Updates
Shows how updating a resource (PUT request) can trigger cache invalidation for related entries.

### 5. Performance Metrics
The example tracks and displays:
- Average response times for cached vs uncached requests
- Cache hit rates
- Total time saved through caching
- Memory usage and cache statistics

## API Endpoints

The example server provides these endpoints:

- `GET /api/products` - List all products (tag: products)
- `GET /api/products/:id` - Get product by ID (tags: products, product:{id})
- `GET /api/products/category/:category` - Get products by category (tags: products, category:{category})
- `GET /api/recommendations/:userId` - Get personalized recommendations (tag: recommendations)
- `GET /api/stats` - Get statistics (expensive operation) (tag: stats)
- `PUT /api/products/:id` - Update product (invalidates cache)
- `POST /api/admin/invalidate-cache` - Manual cache invalidation by tags

## Configuration Options

The example demonstrates key configuration options:

```javascript
const cacheStore = new RedisCacheStore({
  redis: 'redis://localhost:6379',
  ttl: 3600 * 1000,           // Default TTL: 1 hour
  tbd: 300 * 1000,            // Time before deletion: 5 minutes
  cacheTagsHeader: 'Cache-Tags', // Header for cache tags
  tracking: true,             // Enable client-side tracking
  trackingCacheSize: 100,     // LRU cache size
  errorCallback: (err) => {   // Custom error handling
    logger.error(err)
  }
})
```

## Best Practices Demonstrated

1. **Structured Logging**: Using Pino for production-grade logging
2. **Error Handling**: Graceful error handling with proper cleanup
3. **Performance Monitoring**: Tracking cache effectiveness
4. **Cache Headers**: Proper use of Cache-Control headers
5. **Tag Strategy**: Logical grouping of cache entries for efficient invalidation
6. **Resource Cleanup**: Proper connection closing on shutdown

## Extending the Example

You can extend this example by:

1. Adding authentication and per-user caching
2. Implementing cache warming strategies
3. Adding Redis Cluster support for high availability
4. Implementing cache stampede protection
5. Adding metrics export (Prometheus, etc.)
6. Implementing partial cache invalidation patterns

## Troubleshooting

If you encounter issues:

1. Ensure Redis is running: `redis-cli ping` (should return PONG)
2. Check Redis connectivity: `redis-cli -h localhost -p 6379 ping`
3. Verify server is running on port 3000
4. Check logs for error messages
5. Ensure you're using Node.js >= 18.0.0

## Performance Results

Typical performance improvements you should see:

- **First request**: 100-500ms (origin server latency)
- **Cached request**: 1-5ms (Redis lookup only)
- **Speed improvement**: 20-100x faster
- **Cache hit rate**: 80-90% in typical usage

The exact numbers depend on your hardware and network configuration.
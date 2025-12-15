# Performance Benchmarks

This directory contains performance benchmarks for `undici-cache-redis` using [autocannon](https://github.com/mcollina/autocannon).

## Architecture

The benchmarks test a realistic proxy server scenario:

```
┌────────────┐         ┌─────────────────┐         ┌──────────────┐
│ Autocannon │ ──────> │ Server FOO      │ ──────> │ Server Bar   │
│            │         │ (Proxy)         │         │ (Backend API)│
└────────────┘         │                 │         └──────────────┘
                       │ - No Cache      │
                       │ - Memory Cache  │
                       │ - Redis Cache   │
                       └─────────────────┘
```

- **Autocannon**: Load testing tool that generates HTTP requests
- **Server FOO (Proxy)**: Proxy server using Undici with different cache configurations
- **Server Bar (Backend API)**: The actual API server with simulated latency

This architecture tests the real-world scenario where an application (Server FOO) uses Undici with caching to make requests to upstream services (Server Bar).

## Requirements

- Node.js >= 22
- Redis server running on localhost:6379
- Backend API server (Server Bar) running on localhost:3000

## Setup

1. Install dependencies from the project root:

```bash
npm install
```

2. Start Redis (if not already running):

```bash
docker compose up -d
```

3. Start the Backend API Server (Server Bar) from project root:

```bash
npm run example:server
# or
node example/server.ts
```

## Running Benchmarks

### Automated Script (Recommended)

```bash
npm run bench
```

This script will:

1. Check all prerequisites (Node.js, dependencies, Redis connection)
2. Start the backend API server if not already running
3. Run all benchmark scenarios automatically
4. Clean up processes when finished

### Manual Setup

If you prefer to run benchmarks manually:

1. Start the backend server:

```bash
npm run example:server
```

2. In another terminal, run all benchmarks:

```bash
npm run bench
```

This will:

1. Start a proxy server (Server FOO) with no cache and run benchmarks
2. Start a proxy server with memory cache and run benchmarks
3. Start a proxy server with Redis cache and run benchmarks
4. Display a summary comparing all three scenarios

### Run individual benchmarks

```bash
node benchmarks/bench-proxy-no-cache.ts      # Test proxy without caching
node benchmarks/bench-proxy-memory-cache.ts  # Test proxy with in-memory cache
node benchmarks/bench-proxy-redis-cache.ts   # Test proxy with Redis cache
```

## Benchmark Scenarios

### 1. No Cache (`bench-proxy-no-cache.ts`)

- Proxy server forwards all requests to backend without caching
- Every request hits the backend API
- Baseline performance measurement

### 2. Memory Cache (`bench-proxy-memory-cache.ts`)

- Proxy uses Undici's built-in memory cache interceptor
- Cache is local to the proxy process
- Fast but not shared across instances

### 3. Redis Cache (`bench-proxy-redis-cache.ts`)

- Proxy uses Redis-backed cache with client-side tracking
- Cache is shared across multiple proxy instances
- Production-ready configuration with cache tags support

## Understanding Results

The benchmarks measure:

- **Requests/sec**: Throughput (higher is better)
- **Latency (avg)**: Average response time (lower is better)
- **Latency (p95)**: 95th percentile response time (lower is better)
- **Total requests**: Total successful requests during test

### Expected Performance Improvements

Based on actual benchmark results with the proxy architecture:

- **Memory Cache**: 555x improvement over no cache (14.72ms → 0.20ms)
- **Redis Cache**: 550x improvement over no cache (14.72ms → 0.20ms)
- **Scalability**: Redis cache can be shared across multiple proxy instances

**Actual Results:**
| Scenario | Latency (avg) | Latency (p95) | Requests/sec | Improvement |
|----------|---------------|---------------|--------------|-------------|
| No Cache | 14.72ms | 23.98ms | 86.98 | Baseline |
| Memory Cache | 0.20ms | 0.26ms | 48,263 | **555x faster** |
| Redis Cache | 0.20ms | 0.26ms | 47,885 | **550x faster** |

The improvements depend on:

- Backend API latency (higher latency = more benefit from caching)
- Cache hit ratio (more repeated requests = better performance)
- Payload size (larger responses = more network savings)

## Backend API Endpoints

The backend server (Server Bar) simulates realistic API endpoints with 1ms CPU-bound processing using atomic-sleep:

- `/api/products` - 1ms atomic-sleep (product listing)
- `/api/products/:id` - 1ms atomic-sleep (single product)
- `/api/products/category/:category` - 1ms atomic-sleep (category filter)
- `/api/stats` - 1ms atomic-sleep (expensive calculation)
- `/api/recommendations/:userId` - 1ms atomic-sleep (personalized data)

## Proxy Server Configuration

The proxy server (`proxy-server.ts`) can be configured with environment variables:

- `CACHE_TYPE`: Type of cache to use (`none`, `memory`, `redis`)
- `PROXY_PORT`: Port for the proxy server (default: 3001)
- `BACKEND_URL`: URL of the backend API (default: http://localhost:3000)

Example:

```bash
CACHE_TYPE=redis PROXY_PORT=8080 node proxy-server.ts
```

## Interpreting Cache Performance

### Memory Cache Characteristics

- **Pros**: Lowest latency, no network overhead
- **Cons**: Not shared, limited by process memory, lost on restart
- **Use case**: Single instance applications with moderate traffic

### Redis Cache Characteristics

- **Pros**: Shared across instances, persistent, supports cache tags
- **Cons**: Small network overhead, requires Redis infrastructure
- **Use case**: Multi-instance deployments, microservices

## Advanced Configuration

### Redis Cache Options

```javascript
const redisCacheStore = new RedisCacheStore({
  clientOpts: {
    host: 'localhost',
    port: 6379
  },
  cacheTagsHeader: 'Cache-Tags', // Enable cache tag support
  tracking: true, // Enable client-side tracking
  maxSize: 100 * 1024 * 1024, // 100MB max cache size
  maxCount: 10000 // Max number of entries
})
```

### Benchmark Parameters

```javascript
const result = await autocannon({
  url: PROXY_URL,
  connections: 10,      // Concurrent connections
  pipelining: 1,        // HTTP pipelining factor
  duration: 30,         // Test duration in seconds
  requests: [...]       // Request rotation
})
```

## Troubleshooting

1. **Port already in use**: The proxy servers use different ports (3001-3003) to avoid conflicts
2. **Redis connection errors**: Ensure Redis is running on localhost:6379
3. **Backend not responding**: Ensure the API server is running on localhost:3000
4. **Low cache hit ratio**: The benchmarks warm up the cache before measuring

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
services:
  redis:
    image: redis:alpine
    ports:
      - 6379:6379

steps:
  - name: Install Dependencies
    run: npm install

  - name: Start Backend API Server
    run: node example/server.ts &

  - name: Wait for Backend
    run: sleep 5

  - name: Run Benchmarks
    run: npm run bench
```

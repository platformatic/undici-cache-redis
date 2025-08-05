# Performance Benchmarks

This directory contains performance benchmarks for `@platformatic/undici-cache-redis` using [autocannon](https://github.com/mcollina/autocannon).

## Requirements

- Node.js >= 20
- Redis server running on localhost:6379
- API server running on localhost:3000

## Setup

1. Install dependencies:
```bash
cd benchmarks
npm install
```

2. Start Redis (if not already running):
```bash
docker run -p 6379:6379 redis:alpine
```

3. Start the API server (from project root):
```bash
npm run example:server
# or
node example/server.js
```

## Running Benchmarks

### Run all benchmarks
```bash
npm run bench
```

### Run individual benchmarks
```bash
npm run bench:no-cache      # Test without caching
npm run bench:memory-cache  # Test with in-memory cache
npm run bench:redis-cache   # Test with Redis cache
```

## Benchmark Scenarios

### 1. No Cache (`bench-no-cache.js`)
- Direct API calls without any caching
- Baseline performance measurement
- All requests hit the origin server

### 2. In-Memory Cache (`bench-memory-cache.js`)
- Simple Map-based cache implementation
- Single-process caching with TTL support
- Fast but not shared across instances

### 3. Redis Cache (`bench-redis-cache.js`)
- Full Redis-backed caching with client-side tracking
- Shared cache across multiple app instances
- Production-ready configuration

## Understanding Results

The benchmarks measure:
- **Requests/sec**: Throughput (higher is better)
- **Latency (avg)**: Average response time (lower is better)  
- **Latency (p95)**: 95th percentile response time (lower is better)
- **Total requests**: Total successful requests during test

### Expected Performance Improvements

Based on typical results:
- **Memory Cache**: 10-50x improvement over no cache
- **Redis Cache**: 5-25x improvement over no cache
- **Scalability**: Redis cache shared across all app instances

### Factors Affecting Performance

1. **Cache Hit Ratio**: Higher hit ratio = better performance
2. **Payload Size**: Larger responses benefit more from caching
3. **Network Latency**: Redis adds small network overhead vs memory
4. **API Response Time**: Slower APIs show more dramatic improvements

## Interpreting the Numbers

The benchmarks use realistic API endpoints with simulated latency:
- `/api/products` - 200-600ms simulated processing time
- `/api/products/1` - 100-300ms simulated database lookup
- `/api/stats` - 500-1000ms simulated expensive calculation

This simulates real-world scenarios where caching provides significant benefits.

## Customizing Benchmarks

You can modify the benchmark parameters:

```javascript
const result = await autocannon({
  url: API_BASE_URL,
  connections: 10,    // Number of concurrent connections
  pipelining: 1,      // HTTP pipelining factor
  duration: 30,       // Test duration in seconds
  requests: [...]     // Array of requests to cycle through
})
```

## CI/CD Integration

The benchmarks can be run in CI environments by:
1. Starting Redis as a service
2. Starting the API server in background
3. Running `npm run bench`
4. Parsing results for performance regression detection

Example GitHub Actions:
```yaml
services:
  redis:
    image: redis:alpine
    ports:
      - 6379:6379

steps:
  - name: Start API Server
    run: node example/server.js &
  
  - name: Run Benchmarks  
    run: cd benchmarks && npm run bench
```
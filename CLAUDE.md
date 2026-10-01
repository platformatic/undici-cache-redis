# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `undici-cache-redis`, a Redis-backed cache store for Undici's cache interceptor. It provides a cache implementation that integrates with Undici's HTTP client to cache responses in Redis/Valkey, offering both in-memory tracking and persistent storage.

### Core Architecture

- **RedisCacheStore** (lib/redis-cache-store.js): Main cache store implementation that implements Undici's cache store interface
- **RedisCacheManager** (lib/redis-cache-manager.js): Management interface for cache operations and monitoring
- **TrackingCache** (lib/tracking-cache.js): In-memory LRU cache for client-side tracking to reduce Redis round trips
- **lib/entries.js**: Reads and writes the Redis keys of cache entries, shared by the store and the manager
- **lib/keys.js**: The key layout, and the functions that build and parse keys
- **lib/vary.js**: Vary normalization and matching

The architecture uses a dual-layer caching approach:
1. Optional client-side tracking cache (TrackingCache) for frequently accessed items
2. Persistent Redis storage for the main cache data

### Key Storage Patterns

The cache uses structured Redis keys (`{u}` is a hash of origin + path, used as the Cluster hash tag):
- `index:{u}` - Hash with one field per method and Vary variant; lookups read only this and the value
- `values:{u}:{id}` - Actual cached response data
- `metadata:{u}:{origin}:{path}:{method}:{id}` - Cache entry metadata, used by RedisCacheManager
- `ids:{id}` - ID-to-metadata mapping
- `cache-tags:{u}:{tags}:{id}` - Tag keys watched by RedisCacheManager
- `tag-index:{tagHash}` - Set of index fields with the tag, used by `deleteTags()`

## Development Commands

### Testing
```bash
# Run all tests (requires Redis/Valkey running)
npm test

# Start Valkey containers for testing
npm run valkey

# Run the cluster tests (requires the valkey-cluster container)
npm run test:cluster

# Run TypeScript type checking
npm run test:typescript
```

### Benchmarking
```bash
# Run the complete benchmark suite
npm run bench
```

The benchmark script automatically:
- Checks prerequisites (Node.js, dependencies, Redis/Valkey connection)
- Starts Redis/Valkey if needed: `npm run valkey`
- Starts the backend server if not already running
- Runs all three benchmark scenarios (No Cache, Memory Cache, Redis Cache)
- Provides comprehensive performance comparison and analysis
- Cleans up all processes when finished

**Manual benchmarking** (for debugging):
```bash
# Start backend server manually
node example/server.js

# Run individual benchmark scenarios
node benchmarks/bench-proxy-no-cache.js      # No caching baseline
node benchmarks/bench-proxy-memory-cache.js  # In-memory caching  
node benchmarks/bench-proxy-redis-cache.js   # Redis/Valkey caching
```

### Code Quality
```bash
# Run ESLint
npm run lint

# Fix ESLint issues automatically
npm run lint:fix
```

## Testing Setup

Tests require a running Redis/Valkey instance. The project includes Docker Compose configurations:
- `plain-valkey` on port 6379 (default test target)
- `preconfigured-valkey` on port 6389 (with custom config)
- `misconfigured-valkey` on port 6399 (for testing error scenarios)
- `valkey-cluster` on ports 7000-7002 (three-master cluster for `npm run test:cluster`)

Test helper functions are available in test/helper.js:8 for Redis cleanup and data compression utilities.

## Code Patterns

### Error Handling
All Redis operations include error callbacks that can be customized via `opts.errorCallback`. Default behavior logs errors to console.

### Client-Side Tracking
When enabled (default), uses Redis client-side caching with key invalidation notifications. Can be disabled by setting `tracking: false` in options.

### Cache Tagging
Supports cache invalidation by tags via configurable header (set via `cacheTagsHeader` option). Tags are stored in separate Redis keys for efficient bulk invalidation.

### Key Serialization
All cache keys are URL-encoded and follow structured patterns. Metadata keys include origin, path, method, and unique ID components.
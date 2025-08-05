# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@platformatic/undici-cache-redis`, a Redis-backed cache store for Undici's cache interceptor. It provides a cache implementation that integrates with Undici's HTTP client to cache responses in Redis/Valkey, offering both in-memory tracking and persistent storage.

### Core Architecture

- **RedisCacheStore** (lib/redis-cache-store.js:46): Main cache store implementation that implements Undici's cache store interface
- **RedisCacheManager** (lib/redis-cache-store.js:665): Management interface for cache operations and monitoring
- **TrackingCache** (lib/tracking-cache.js:5): In-memory LRU cache for client-side tracking to reduce Redis round trips

The architecture uses a dual-layer caching approach:
1. Optional client-side tracking cache (TrackingCache) for frequently accessed items
2. Persistent Redis storage for the main cache data

### Key Storage Patterns

The cache uses structured Redis keys:
- `metadata:{origin}:{path}:{method}:{id}` - Cache entry metadata
- `values:{id}` - Actual cached response data
- `ids:{id}` - ID-to-metadata mapping
- `cache-tags:{tags}:{id}` - Tag-based invalidation support

## Development Commands

### Testing
```bash
# Run all tests (requires Redis/Valkey running)
npm test

# Start Valkey containers for testing
npm run valkey

# Run TypeScript type checking
npm run test:typescript
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
# undici-cache-redis

Redis/Valkey-backed cache store for Undici's cache interceptor.

The default API uses a unified `RedisCache` class for both HTTP cache storage and cache-management operations, with indexed Redis data structures that avoid `SCAN` on the request lookup path.

## Features

- Redis/Valkey-backed HTTP response caching for Undici.
- Proper `Vary` support with most-specific match selection.
- Cache invalidation by origin, method, path, id, and tags.
- Unified store and manager API.
- Optional client-side tracking cache.
- Prefix-based namespacing for multi-tenant deployments.
- Indexed data model using sorted sets and `xxhash-wasm`.

## Requirements

- Node.js >= 20
- Redis >= 7.0 or Valkey >= 8.0
- Undici >= 7.0

## Installation

```bash
npm install undici-cache-redis
```

## Quick Start

```js
import { Agent, interceptors } from 'undici'
import { createStore } from 'undici-cache-redis'

const store = createStore({
  prefix: 'my-app:cache',
  // Optional Redis Cluster hash tag. If omitted, the namespace hash tag is used.
  clusterId: 'tenant-a',
  clientOpts: {
    host: 'localhost',
    port: 6379
  }
})

const agent = new Agent().compose(interceptors.cache({ store }))

const response = await agent.request({
  origin: 'https://api.example.com',
  method: 'GET',
  path: '/users/123'
})

console.log(await response.body.text())
```

The default export is also the `RedisCache` class:

```js
import RedisCache from 'undici-cache-redis'

const cache = new RedisCache({ prefix: 'my-app:cache' })
```

## API

`createStore()` and `createManager()` both return a `RedisCache` instance.

```js
import { RedisCache, createManager, createStore } from 'undici-cache-redis'

const store = createStore({ prefix: 'my-app:cache' })
const manager = createManager({ prefix: 'my-app:cache' })
const cache = new RedisCache({ prefix: 'my-app:cache' })
```

### Store Operations

- `get(key, prefixes?, includeBody?)`
- `getKeys(keys, prefixes?)`
- `createWriteStream(key, value)`
- `delete(key, prefixes?)`
- `deleteKeys(keys, prefixes?)`
- `deleteTag(tags, prefixes?)`
- `deleteTags(tags, prefixes?)`
- `deleteIds(ids, prefixes?)`
- `close()`

### Manager Operations

- `entries(filter?, prefixes?)`
- `deleteEntries(filter?, prefixes?)`
- `streamEntries(callback, prefixes?)`
- `getTag(tag, prefixes?)`
- `getTags(tags, prefixes?)`
- `getResponseById(id, prefixes?)`
- `getDependentEntries(id, prefixes?)`
- `subscribe(prefixes?)`

Supported `entries()` / `deleteEntries()` filters:

```js
await cache.entries()
await cache.entries({ id })
await cache.entries({ origin })
await cache.entries({ origin, method })
await cache.entries({ origin, path })
await cache.entries({ origin, method, path })
```

`delete(key)` preserves V1 semantics: it deletes all entries for `origin + path`, across all methods.

`deleteKeys(keys)` deletes exact `origin + method + path` entries, or by `id` if present.

## Cache Tags

Configure the response header used for tags:

```js
const cache = createStore({
  prefix: 'my-app:cache',
  cacheTagsHeader: 'cache-tags'
})
```

If the origin responds with:

```text
Cache-Tags: user:123,profile
```

you can invalidate matching entries with:

```js
await cache.deleteTags(['user:123'])
await cache.deleteTags([['user:123', 'profile']])
```

Tag index keys are hashed with `xxhash-wasm`; original tag names are kept in entry metadata.

## Prefixes

All keys are namespaced by `prefix` and the internal data-version segment.

Most operations can target one or more prefixes:

```js
await cache.entries({}, ['tenant-a', 'tenant-b'])
await cache.deleteTags(['user:123'], ['tenant-a', 'tenant-b'])
```

`clientOpts.keyPrefix` is accepted as a migration convenience, but new code should prefer `prefix`.

Keys are Redis Cluster hash-tagged by default. Without `clusterId`, the hash tag is the namespace plus the data-version segment. With `clusterId`, only the cluster id is hash-tagged and the prefix remains outside the hash tag.

`prefix` and `clusterId` cannot contain `{` or `}`. `prefix` can be empty. `clusterId`, if provided, cannot be empty.

## Data Model

The cache uses sorted-set indexes scored by `deleteAt`, explicit payload expiration, and `xxhash-wasm` hashes for resource identities and tag index keys.

Payload keys use `SET ... EXAT`. Index keys use `ZADD` plus `EXPIREAT ... NX` and `EXPIREAT ... GT`, so cold indexes disappear automatically and hot indexes stay alive as long as they contain live entries.

See [docs/data-model.md](./docs/data-model.md).

## Events

Local events:

- `entry:write`
- `entry:delete`
- `tag:delete`
- `error`

Subscription events after `await cache.subscribe()`:

- `subscription:entry:add`
- `subscription:entry:delete`

Client-side tracking and keyspace subscriptions use separate Redis clients.

## Managed Redis Services

For managed Redis/Valkey services where `CONFIG SET` is restricted, disable automatic keyspace configuration:

```js
const cache = createStore({
  clientConfigKeyspaceEventNotify: false,
  clientOpts: {
    host: 'your-cluster.cache.amazonaws.com',
    port: 6379
  }
})
```

If you use `subscribe()`, configure keyspace notifications externally:

```text
notify-keyspace-events = AKE
```

## Benchmarking

Run the general benchmark suite:

```bash
npm run bench
```

Compare legacy `SCAN` lookup with indexed lookup:

```bash
npm run bench:scan-vs-index
```

Useful environment variables:

```bash
UNRELATED_KEYS=100000 LOOKUPS=1000 VARIANTS=16 npm run bench:scan-vs-index
```

## V1 Compatibility

V1 remains available for compatibility:

```js
import {
  RedisCacheStore,
  RedisCacheManager,
  createStore,
  createManager
} from 'undici-cache-redis'

const store = new RedisCacheStore(options)
const manager = new RedisCacheManager(options)

const sameStore = createStore(options, '1.0.0')
const sameManager = createManager(options, '1.0.0')
```

See [docs/v1.md](./docs/v1.md).

For migration guidance, see [docs/migration.md](./docs/migration.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).

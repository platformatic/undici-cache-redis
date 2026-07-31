# Migrating To V2

V2 is the default API for the next major release. It keeps V1 cache semantics, but changes the public API shape and Redis data model.

## Main Changes

- The default export is now `RedisCache`.
- `createStore()` and `createManager()` both return a V2 `RedisCache` instance.
- Store and manager operations are available on the same object.
- V2 uses hash-tagged `data:v2` keys and does not read V1 cache data.
- V2 keys are Redis Cluster hash-tagged. Prefixes containing `{` or `}` are rejected.
- V2 requires Redis >= 7.0 or Valkey >= 8.0.
- V2 avoids `SCAN` on HTTP cache lookup.
- Tag index keys are hashed. Original tag names remain in entry metadata.

## Basic Usage

V1:

```js
import { RedisCacheStore } from 'undici-cache-redis'

const store = new RedisCacheStore({
  clientOpts: {
    keyPrefix: 'my-app:cache:'
  }
})
```

V2:

```js
import RedisCache from 'undici-cache-redis'

const store = new RedisCache({
  prefix: 'my-app:cache'
})
```

Or with the factory:

```js
import { createStore } from 'undici-cache-redis'

const store = createStore({
  prefix: 'my-app:cache'
})
```

## Prefixes

V1 used `clientOpts.keyPrefix`.

V2 prefers `prefix`:

```js
const cache = createStore({ prefix: 'my-app:cache' })
```

`clientOpts.keyPrefix` is still accepted as a migration convenience, but new V2 code should use `prefix`.

If `clusterId` is provided, it is used as the Redis Cluster hash tag:

```js
const cache = createStore({
  prefix: 'my-app:cache',
  clusterId: 'tenant-a'
})
```

## Manager Operations

V1 used two classes:

```js
import { RedisCacheManager, RedisCacheStore } from 'undici-cache-redis'

const store = new RedisCacheStore(storeOptions)
const manager = new RedisCacheManager(managerOptions)
```

V2 uses one class:

```js
import { createStore } from 'undici-cache-redis'

const cache = createStore(options)

await cache.streamEntries(entry => {
  console.log(entry.id, entry.origin, entry.path)
})

await cache.deleteIds(['entry-id'])
await cache.getResponseById('entry-id')
```

`createManager()` exists for readability, but returns the same V2 class:

```js
import { createManager } from 'undici-cache-redis'

const manager = createManager(options)
```

## Deletion Semantics

V2 preserves the important V1 semantics:

- `delete(key)` deletes by `origin + path`, across all methods.
- `deleteKeys(keys)` deletes by exact `origin + method + path`, or by `id` if present.
- `deleteTags(tags)` deletes entries matching a tag or tag combination.
- `deleteIds(ids)` deletes entries by id.

V2 also adds generic indexed operations:

```js
await cache.entries({ origin })
await cache.entries({ origin, method })
await cache.entries({ origin, path })
await cache.entries({ origin, method, path })

await cache.deleteEntries({ origin, method, path })
```

## V1 Compatibility

V1 remains available:

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

## Data Compatibility

V1 and V2 data coexist but are independent.

- V1 keys use `metadata:*`, `values:*`, `ids:*`, and `cache-tags:*`.
- V2 keys use hash-tagged `data:v2` namespaces, such as `{my-app:cache:data:v2}:*`.

There is no automatic migration from V1 data to V2 data. Existing V1 cache entries should be treated as disposable cache state.

## Events

V1 manager events:

- `add-entry`
- `delete-entry`

V2 subscription events:

- `subscription:entry:add`
- `subscription:entry:delete`

V2 local events:

- `entry:write`
- `entry:delete`
- `tag:delete`

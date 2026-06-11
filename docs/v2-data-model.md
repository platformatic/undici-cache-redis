# V2 Data Model

## Goals

- Support the V1 cache semantics without preserving the V1 API shape.
- Collapse store and manager behavior into one `RedisCache` class.
- Avoid `SCAN` on the HTTP cache hot path.
- Keep package/API version separate from data schema version.
- Support prefixes/namespaces for every key.
- Target Redis 7 or Valkey 8 and use concise command syntax where available.

## Versioning

The data version is implicit in the Redis key namespace:

```text
data:v2
```

The package/API version can change independently in the future. There is no public data-version option.

## Cluster Hash Tags

V2 keys are Redis Cluster hash-tagged.

Without `clusterId`, the hash tag is `prefix + data:v2`:

```text
{my-app:cache:data:v2}:entry:{id}
```

With `clusterId`, only the cluster id is hash-tagged:

```text
my-app:cache:{tenant-a}:data:v2:entry:{id}
```

With an empty prefix, keys do not start with `:`:

```text
{data:v2}:entry:{id}
{tenant-a}:data:v2:entry:{id}
```

`prefix` and `clusterId` cannot contain `{` or `}`. `prefix` can be empty. `clusterId`, if provided, cannot be empty.

## Hashing

V2 uses `xxhash-wasm` for fast deterministic hashes.

```text
originHash = hash(origin)
originMethodHash = hash([origin, method])
originPathHash = hash([origin, path])
resourceHash = hash([origin, method, path])
varyHash = hash(normalizedVary)
tagHash = hash(tag)
```

Hashes are identifiers only. Original `origin`, `method`, `path`, `vary`, and tag values are stored in entry metadata.

## Keys

Payload keys:

```text
{namespace}:entry:{id}
{namespace}:body:{id}
```

Primary resource bucket:

```text
{namespace}:resource:{resourceHash}
```

Search/delete indexes:

```text
{namespace}:index:all
{namespace}:index:origin:{originHash}
{namespace}:index:origin-method:{originMethodHash}
{namespace}:index:origin-path:{originPathHash}
{namespace}:index:resource:{resourceHash}
```

Tag index:

```text
{namespace}:tag:{tagHash}
```

All index keys and resource buckets are sorted sets:

```text
member = id
score = deleteAtSeconds
```

## Entry Metadata

```js
{
  id,
  prefix,
  origin,
  method,
  path,
  originHash,
  originMethodHash,
  originPathHash,
  resourceHash,
  varyHash,
  vary,
  specificity,
  tags,
  tagHashes,
  statusCode,
  statusMessage,
  headers,
  cachedAt,
  staleAt,
  deleteAt,
  cacheControlDirectives
}
```

## Expiration

Payload keys use hard Redis expiry:

```text
SET entry:{id} json EXAT deleteAt
SET body:{id} body EXAT deleteAt
```

Indexes and resource buckets expire at the latest member `deleteAt`:

```text
ZADD index deleteAt id
EXPIREAT index deleteAt NX
EXPIREAT index deleteAt GT
```

Reads, writes, and deletes clean touched indexes with:

```text
ZREMRANGEBYSCORE index -inf now
```

This means expired entries are never returned, hot indexes stay compact, and cold indexes disappear automatically.

## HTTP Lookup

`get(key)` computes `resourceHash`, reads live ids from the resource bucket, hydrates entry metadata, filters by `Vary`, chooses the most specific match, then reads the selected body.

Same `resourceHash + varyHash` replaces the previous entry. Different `varyHash` values coexist.

## Search And Delete Levels

V2 supports these indexed levels:

- all
- origin
- origin + method
- origin + path
- origin + method + path
- id
- tags

V1 `delete(key)` maps to `origin + path`, across all methods.

V1 `deleteKeys(keys)` maps to `origin + method + path`.

## Commands

The V2 data path uses common Redis 7 / Valkey 8 commands:

- `GET`
- `MGET`
- `SET ... EXAT`
- `DEL`
- `ZADD`
- `ZREM`
- `ZRANGEBYSCORE`
- `ZREMRANGEBYSCORE`
- `EXPIREAT ... NX`
- `EXPIREAT ... GT`

`SCAN` is not used for HTTP lookup.

## Subscriptions

V2 uses separate Redis clients for client-side tracking invalidations and keyspace notifications. This keeps `CLIENT TRACKING` traffic independent from manager-style `subscribe()` events.

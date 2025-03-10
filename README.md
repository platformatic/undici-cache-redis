# @platformatic/undici-cache-redis

A Redis-backed cache store for Undici's cache interceptor. Under the hood, this
uses [iovalkey](https://github.com/valkey-io/iovalkey).

## Usage

> Note: This assumes that the Redis server is already setup and ready to be connected to.

```javascript
const { Client, interceptors } = require('undici')
const { RedisCacheStore } = require('@platformatic/undici-cache-redis')

const client = new Client('http://localhost')
  .compose(interceptors.cache({
    store: new RedisCacheStore({
      // Optional, any options to pass to iovalkey.
      clientOpts: {
        keyPrefix: 'cache-interceptor:',
        // ...
      },
      
      // Optional, the max body size in bytes of a response to store. If a
      //  response's body size exceeds this, the response will not be cached.
      maxSize: Infinity
    })
  }))
```

### Restricted commands

In managed Redis/Valkey environments, like Elasticache, some commands are not
available or are restricted. When using a managed service, make sure that
`notify-keyspace-events` is available. By default, `undici-redis-cache` will
attempt to turn this setting on. To avoid failure in managed environments, set
the following additional options:

```js
const cacheManager = new RedisCacheManager({
    clientConfigKeyspaceEventNotify: false,
    // ...
})
```

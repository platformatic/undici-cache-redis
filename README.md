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

      // Optional, the maximum amount of entries to store. If the number of
      //  responses stored in Redis is above or equal to this number, no more
      //  responses will be cached.
      maxEntries: Infinity,
      
      // Optional, the max body size in bytes of a response to store. If a
      //  response's body size exceeds this, the response will not be cached.
      maxEntrySize: Infinity
    })
  }))
```

## License

This repository is licensed under the [MIT License](./LICENSE).

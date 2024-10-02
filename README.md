# undici-cache-redis

TODO

## Usage

```javascript
const { Client, interceptors } = require('undici')
const { RedisCacheStore } = require('@platformatic/undici-cache-redis')

const client = new Client('http://localhost')
  .compose(interceptors.cache({
    store: new RedisCacheStore({/* ... */})
  }))
```

todo note needs `notify-keyspace-events` enabled
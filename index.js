'use strict'

const { RedisCacheStore, RedisCacheManager } = require('./lib/redis-cache-store')

module.exports = RedisCacheStore
module.exports.RedisCacheStore = RedisCacheStore
module.exports.RedisCacheManager = RedisCacheManager

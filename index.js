'use strict'

const RedisCacheStore = require('./lib/redis-cache-store')
const RedisCacheManager = require('./lib/redis-cache-manager')

module.exports = RedisCacheStore
module.exports.RedisCacheStore = RedisCacheStore
module.exports.RedisCacheManager = RedisCacheManager

// @ts-check
'use strict'

/**
 * Promote endpoint security options to every discovered shard connection.
 * iovalkey's Cluster URL parser does not promote rediss or credentials.
 * @param {import('../index.d.ts').RedisCacheStoreOpts} opts
 * @param {import('iovalkey').RedisOptions} clientOpts
 */
function clusterOptions (opts, clientOpts) {
  const source = opts.clusterUrl ?? opts.startupNodes ?? { host: '127.0.0.1', port: 6379 }
  const endpoints = Array.isArray(source) ? source : [source]
  const security = {}
  let secure = false
  let plain = false
  const startupNodes = endpoints.map(endpoint => {
    if (typeof endpoint !== 'string') return endpoint
    const url = new URL(endpoint.includes('://') ? endpoint : `redis://${endpoint}`)
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new TypeError('cluster endpoints must use redis:// or rediss://')
    }
    if (url.pathname && url.pathname !== '/' && url.pathname !== '/0') {
      throw new TypeError('cluster endpoints only support database 0')
    }
    secure ||= url.protocol === 'rediss:'
    plain ||= url.protocol === 'redis:'
    for (const name of ['username', 'password']) {
      if (!url[name]) continue
      const value = decodeURIComponent(url[name])
      if (security[name] !== undefined && security[name] !== value) {
        throw new TypeError('cluster startup nodes must use the same credentials')
      }
      security[name] = value
    }
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 6379) }
  })
  if (secure && plain) throw new TypeError('cannot mix redis:// and rediss:// cluster endpoints')
  const options = {
    ...opts.clusterOptions,
    redisOptions: { enableAutoPipelining: true, ...security, ...clientOpts, ...opts.clusterOptions?.redisOptions }
  }
  if (secure) {
    if (options.redisOptions.tls === false) throw new TypeError('rediss:// requires TLS')
    options.redisOptions.tls ??= {}
  }
  assertMasterReads(options)
  return { startupNodes, options }
}

/**
 * Replica reads can return a stale index/body after an acknowledged purge.
 * @param {import('iovalkey').ClusterOptions} options
 */
function assertMasterReads (options) {
  if (options.scaleReads !== undefined && options.scaleReads !== 'master') {
    throw new TypeError('cache cluster clients require scaleReads: "master"')
  }
}

module.exports = { clusterOptions, assertMasterReads }

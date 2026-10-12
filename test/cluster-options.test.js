'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual, throws } = require('node:assert')
const { clusterOptions, assertMasterReads } = require('../lib/cluster-options.js')

test('rediss URL security applies to all discovered cluster nodes', () => {
  const { startupNodes, options } = clusterOptions({ clusterUrl: 'rediss://cache-user:p%40ss@localhost:7100/0' }, {})
  deepStrictEqual(startupNodes, [{ host: 'localhost', port: 7100 }])
  deepStrictEqual(options.redisOptions.tls, {})
  strictEqual(options.redisOptions.username, 'cache-user')
  strictEqual(options.redisOptions.password, 'p@ss')
})

test('explicit TLS and credentials override endpoint defaults', () => {
  const tls = { ca: 'test CA', servername: 'localhost' }
  const { options } = clusterOptions({
    clusterUrl: 'rediss://user:password@localhost',
    clusterOptions: { redisOptions: { tls, password: 'override' } }
  }, {})
  strictEqual(options.redisOptions.tls, tls)
  strictEqual(options.redisOptions.password, 'override')
})

test('validates protocol, database, endpoint security and read consistency', () => {
  throws(() => clusterOptions({ clusterUrl: 'https://localhost' }, {}), /redis:\/\//)
  throws(() => clusterOptions({ clusterUrl: 'redis://localhost/1' }, {}), /database 0/)
  throws(() => clusterOptions({ startupNodes: ['redis://localhost', 'rediss://localhost'] }, {}), /cannot mix/)
  throws(() => clusterOptions({ clusterUrl: 'rediss://localhost', clusterOptions: { redisOptions: { tls: false } } }, {}), /requires TLS/)
  throws(() => clusterOptions({ startupNodes: ['redis://u:a@localhost', 'redis://u:b@localhost:7001'] }, {}), /same credentials/)
  throws(() => assertMasterReads({ scaleReads: 'slave' }), /scaleReads/)
  throws(() => assertMasterReads({ scaleReads: () => [] }), /scaleReads/)
})

test('accepts a hostname, IPv6 and object startup nodes', () => {
  deepStrictEqual(clusterOptions({ clusterUrl: 'cache.example.com' }, {}).startupNodes, [{ host: 'cache.example.com', port: 6379 }])
  deepStrictEqual(clusterOptions({ clusterUrl: 'redis://[::1]:7000' }, {}).startupNodes, [{ host: '::1', port: 7000 }])
  deepStrictEqual(clusterOptions({ startupNodes: [{ host: 'localhost', port: 7001 }] }, {}).startupNodes, [{ host: 'localhost', port: 7001 }])
})

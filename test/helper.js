'use strict'

const { once } = require('node:events')
const { createGzip, createGunzip } = require('node:zlib')
const { Redis } = require('iovalkey')

const REDIS_CONNECTION_STRING = 'redis://localhost:6379'

async function cleanValkey () {
  const redis = new Redis(REDIS_CONNECTION_STRING)
  await redis.flushall()
  redis.quit()
}

async function getAllKeys () {
  const redis = new Redis(REDIS_CONNECTION_STRING)
  const keys = await redis.keys('*')
  redis.quit()

  return keys
}

async function gzip (data) {
  const gzippedData = []
  const stream = createGzip()

  stream.on('data', data => {
    gzippedData.push(data)
  })

  stream.end(data)
  await once(stream, 'end')

  return Buffer.concat(gzippedData)
}

async function ungzip (data) {
  const ungzippedData = []
  const stream = createGunzip()

  stream.on('data', data => {
    ungzippedData.push(data)
  })

  stream.end(Buffer.from(data))
  await once(stream, 'end')

  return Buffer.concat(ungzippedData)
}

module.exports = {
  cleanValkey,
  getAllKeys,
  gzip,
  ungzip
}

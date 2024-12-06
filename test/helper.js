'use strict'

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

module.exports = {
  cleanValkey,
  getAllKeys
}

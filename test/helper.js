import { once } from 'node:events'
import { createGzip, createGunzip } from 'node:zlib'
import { Redis } from 'iovalkey'

const REDIS_CONNECTION_STRING = 'redis://localhost:6379'

export async function cleanValkey () {
  const redis = new Redis(REDIS_CONNECTION_STRING)
  await redis.flushall()
  redis.quit()
}

export async function getAllKeys () {
  const redis = new Redis(REDIS_CONNECTION_STRING)
  const keys = await redis.keys('*')
  redis.quit()

  return keys
}

export async function gzip (data) {
  const gzippedData = []
  const stream = createGzip()

  stream.on('data', data => {
    gzippedData.push(data)
  })

  stream.end(data)
  await once(stream, 'end')

  return Buffer.concat(gzippedData)
}

export async function ungzip (data) {
  const ungzippedData = []
  const stream = createGunzip()

  stream.on('data', data => {
    ungzippedData.push(data)
  })

  stream.end(Buffer.from(data))
  await once(stream, 'end')

  return Buffer.concat(ungzippedData)
}

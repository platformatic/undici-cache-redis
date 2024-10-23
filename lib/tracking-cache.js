'use strict'

const REDIS_INVALIDATE_CHANNEL = '__redis__:invalidate'

/**
 * Client side cache for Redis
 * @see https://redis.io/docs/latest/develop/reference/client-side-caching/
 *
 * Aims to be interchangable with a Redis client (for the functions relevant to us)
 */
class TrackingCache {
  /**
   * @param {Map<string, unknown>}
   */
  #data = new Map()

  /**
   * Note: we're not responsible for closing this. We don't own this variable.
   * @type {import('iovalkey').Redis}
   */
  #dataClient

  /**
   * @type {import('iovalkey').Redis}
   */
  #subClient

  /**
   * @param {import('iovalkey').Redis} dataClient
   * @param {import('iovalkey').Redis} subClient
   * @param {((err: Error) => void) | undefined} errorCallback
   */
  constructor (dataClient, subClient, errorCallback) {
    this.#dataClient = dataClient

    this.#subClient = subClient
    this.#subClient.call('CLIENT', 'ID')
      .then(clientId => (
        this.#dataClient.call('CLIENT', 'TRACKING', 'on', 'REDIRECT', clientId)
      ))
      .then(this.#subClient.subscribe(REDIS_INVALIDATE_CHANNEL))
      .catch(err => {
        if (errorCallback) {
          errorCallback(err)
        }
      })

    this.#subClient.on('message', (channel, message) => {
      if (channel === REDIS_INVALIDATE_CHANNEL) {
        this.#data.delete(message)
      }
    })
  }

  async quit () {
    return this.#subClient.quit()
  }

  /**
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async get (key) {
    let value = this.#data.get(key)

    if (value) {
      if (typeof value !== 'string') {
        throw new TypeError(`type mismatch when running get, expected string but got ${typeof value}`)
      }
    } else {
      value = await this.#dataClient.get(key)
      if (value) {
        this.#data.set(key, value)
      }
    }

    return value
  }

  /**
   * @param {string} key
   * @param {string | Buffer} field
   * @returns {Promise<string | null>}
   */
  async hget (key, field) {
    let value = this.#data.get(key)

    /**
     * @type {string | null}
     */
    let fieldValue = null
    if (value) {
      if (typeof value !== 'object') {
        throw new TypeError(`type mismatch when running hget, expected object but got ${typeof value}`)
      }

      if (field in value) {
        fieldValue = value[field]
      } else {
        fieldValue = await this.#dataClient.hget(key, field)
        value[field] = fieldValue
      }
    } else {
      fieldValue = await this.#dataClient.hget(key, field)

      if (fieldValue) {
        value = {}
        value[field] = fieldValue
        this.#data.set(key, value)
      }
    }

    return fieldValue
  }

  /**
   * @param {string} key
   * @returns {Promise<Record<string, string>>}
   */
  async hgetall (key) {
    let value = this.#data.get(key)

    if (value) {
      if (typeof value !== 'object') {
        throw new TypeError(`type mismatch when running hgetall, expected object but got ${typeof value}`)
      }
    } else {
      value = await this.#dataClient.hgetall(key)
      this.#data.set(key, value)
    }

    return { ...value }
  }
}

module.exports = TrackingCache

'use strict'

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
   * @type {import('iovalkey').Redis}
   */
  #client

  /**
   * @param {import('iovalkey').Redis} client
   */
  constructor (client) {
    this.#client = client
  }

  /**
   * @param {string} key
   */
  invalidate (key) {
    this.#data.delete(key)
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
      value = await this.#client.get(key)
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
        fieldValue = await this.#client.hget(key, field)
        value[field] = fieldValue
      }
    } else {
      fieldValue = await this.#client.hget(key, field)

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
      value = await this.#client.hgetall(key)
      this.#data.set(key, value)
    }

    return value
  }
}

module.exports = TrackingCache

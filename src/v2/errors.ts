const kGenericError = Symbol('undici.cache.redis.genericError')

export const ERROR_PREFIX = 'UND_CACHE_REDIS_'

export const errorCodes = [
  ERROR_PREFIX + 'USER',
  ERROR_PREFIX + 'INVALID_OPTION',
  ERROR_PREFIX + 'MAX_ENTRY_SIZE_EXCEEDED'
] as const

export type ErrorCode = (typeof errorCodes)[number]

export type ErrorProperties = { cause?: Error } & Record<string, any>

export class GenericError extends Error {
  code: string;
  [index: string]: any
  [kGenericError]: true

  static isGenericError (error: Error): error is GenericError {
    return (error as GenericError)[kGenericError] === true
  }

  constructor (code: ErrorCode, message: string, { cause, ...rest }: ErrorProperties = {}) {
    /* c8 ignore next */
    super(message, cause ? { cause } : {})
    this.code = code
    this[kGenericError] = true

    Reflect.defineProperty(this, 'message', { enumerable: true })
    Reflect.defineProperty(this, 'code', { enumerable: true })

    if ('stack' in this) {
      Reflect.defineProperty(this, 'stack', { enumerable: true })
    }

    for (const [key, value] of Object.entries(rest)) {
      Reflect.defineProperty(this, key, { value, enumerable: true })
    }

    Reflect.defineProperty(this, kGenericError, { value: true, enumerable: false })
  }
}

export class UserError extends GenericError {
  static code: ErrorCode = 'UND_CACHE_REDIS_USER'

  constructor (message: string, properties: ErrorProperties = {}) {
    super(UserError.code, message, properties)
  }
}

export class InvalidOptionError extends GenericError {
  static code: ErrorCode = 'UND_CACHE_REDIS_OPTION'

  constructor (message: string, properties: ErrorProperties = {}) {
    super(InvalidOptionError.code, message, properties)
  }
}

export class MaxEntrySizeExceededError extends GenericError {
  static code: ErrorCode = 'UND_CACHE_REDIS_MAX_ENTRY_SIZE_EXCEEDED'

  constructor (message: string, properties: ErrorProperties = {}) {
    super(MaxEntrySizeExceededError.code, message, properties)
  }
}

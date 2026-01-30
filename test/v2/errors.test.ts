import { deepStrictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { InvalidOptionError, MaxEntrySizeExceededError, UserError } from '../../src/v2/errors.ts'

test('should correctly initialize errors', t => {
  const userError = new UserError('An user error occurred', { detail: 'Extra detail' })
  deepStrictEqual(userError.code, 'UND_CACHE_REDIS_USER')
  deepStrictEqual(userError.detail, 'Extra detail')

  ok(UserError.isGenericError(userError))

  deepStrictEqual(new InvalidOptionError('Invalid option provided').code, 'UND_CACHE_REDIS_OPTION')
  deepStrictEqual(
    new MaxEntrySizeExceededError('Max entry size exceeded').code,
    'UND_CACHE_REDIS_MAX_ENTRY_SIZE_EXCEEDED'
  )
})

import type { CacheEntry } from '../types.ts'

export interface Keys {
  routes: string
  tags: string
  requests: string
  request: string
  variants: string
  metadata: string
  body: string
}

export interface CacheIdentifier {
  score: string
  id: string
  specificity: number
  vary: Record<string, string>
  tags: string[]
  hash: string
  expireAt: number
}

export interface CacheMetadata {
  identifier: CacheIdentifier
  entry: CacheEntry
}

export interface CleanupTask {
  prefix: string
  type: 'map' | 'tags' | 'key'
  target: Record<string, string[]> | string[] | string
}

export type VariantsIterationResultCallback<ReturnType> = (
  member: string
) =>
  | Promise<VariantsIterationResult<ReturnType> | undefined | void>
  | VariantsIterationResult<ReturnType>
  | undefined
  | void

export interface VariantsIterationResult<ReturnType> {
  value?: ReturnType
  expired?: boolean
}

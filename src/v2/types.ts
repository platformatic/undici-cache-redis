import type { CacheValue, CacheValueAdditionalProperties } from '../types.ts'

export interface Keys {
  routes: string
  tags: string
  requests: string
  request: string
  variants: string
  value: string
  body: string
}

export interface CacheMetadata extends CacheValueAdditionalProperties {
  score: string
  specificity: number
  hash: string
  vary: Record<string, string>
  deleteAt: number
}

export interface CacheEntry {
  metadata: CacheMetadata
  value: CacheValue
}

export interface AddedCacheEntry extends CacheEntry {
  prefix: string
  id: string
}

export interface RemovedCacheEntry {
  prefix: string
  id: string
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

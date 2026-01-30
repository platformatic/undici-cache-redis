import type { RedisOptions } from 'iovalkey'

export function ensureArray<T> (item: T | T[]): T[] {
  return Array.isArray(item) ? item : [item]
}

export function getKeyspaceEventsChannels (options: RedisOptions, ...channels: string[]): Record<string, string> {
  /* c8 ignore next */
  const db = options.db ?? 0

  return Object.fromEntries(channels.map(channel => [channel, `__keyevent@${db}__:${channel}`]))
}

import type { CodingNsCliAdapterId } from './contracts/cli-adapter.js'

export const CLI_PROVIDER_PREFIX = 'codingns-cli-'

/** DSH provider routes are global; persisted adapter IDs remain plugin-local. */
export function toCliProviderId(adapterId: CodingNsCliAdapterId): string {
  return `${CLI_PROVIDER_PREFIX}${adapterId}`
}

/** A bare brand name does not establish ownership of a DSH provider. */
export function fromCliProviderId(provider: unknown): CodingNsCliAdapterId | undefined {
  if (typeof provider !== 'string' || !provider.startsWith(CLI_PROVIDER_PREFIX)) return undefined
  const adapterId = provider.slice(CLI_PROVIDER_PREFIX.length)
  return adapterId === '' ? undefined : adapterId
}

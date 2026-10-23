import { createElement } from 'react'
import type { ReactElement } from 'react'
import { providerIconUrlForIdentities } from '../provider-icons.js'

export interface MagpieProviderLogoProps {
  readonly identities: readonly (string | null | undefined)[]
  /** A Host-fetched Magpie asset takes precedence over local icon inference. */
  readonly logoDataUrl?: string | null | undefined
  readonly size?: number
  readonly className?: string
  readonly fallback?: 'initial' | 'none'
}

export function MagpieProviderLogo({ identities, logoDataUrl, size = 24, className = 'codingns-magpie-provider-logo', fallback = 'initial' }: MagpieProviderLogoProps): ReactElement | null {
  const identity = identities.find((value) => value !== undefined && value !== null && value.trim() !== '')
  const iconUrl = logoDataUrl?.trim() || providerIconUrlForIdentities(identities)
  const style = { width: size, height: size }
  if (iconUrl !== undefined) {
    return createElement('img', {
      className,
      src: iconUrl,
      alt: '',
      'aria-hidden': true,
      width: size,
      height: size,
      style,
    })
  }
  if (fallback === 'none') return null
  return createElement('span', {
    className,
    'aria-hidden': true,
    style,
  }, identity?.trim().slice(0, 1).toLocaleUpperCase() ?? '·')
}

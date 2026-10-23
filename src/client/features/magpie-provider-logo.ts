import { createElement } from 'react'
import type { ReactElement } from 'react'
import { providerIconUrl } from '../provider-icons.js'

export interface MagpieProviderLogoProps {
  readonly identities: readonly (string | null | undefined)[]
  readonly size?: number
  readonly className?: string
  readonly fallback?: 'initial' | 'none'
}

export function MagpieProviderLogo({ identities, size = 24, className = 'codingns-magpie-provider-logo', fallback = 'initial' }: MagpieProviderLogoProps): ReactElement | null {
  const identity = identities.find((value) => value !== undefined && value !== null && value.trim() !== '')
  const iconUrl = identities
    .flatMap((value) => value === undefined || value === null ? [] : [providerIconUrl(value)])
    .find((value): value is string => value !== undefined)
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

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
  const hostLogo = logoDataUrl?.trim() ?? ''
  const iconUrl = hostLogo !== '' ? hostLogo : providerIconUrlForIdentities(identities)
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
      // Magpie serves brand marks on a transparent background in its own glyph colour, which
      // disappears on a dark theme when it is black. Magpie's own pages show them on a white
      // tile, so a Host-fetched `file:` image gets one too.
      ...(isHostImageAsset(hostLogo) ? { 'data-host-asset': '' } : {}),
    })
  }
  if (fallback === 'none') return null
  return createElement('span', {
    className,
    'aria-hidden': true,
    style,
  }, identity?.trim().slice(0, 1).toLocaleUpperCase() ?? '·')
}

/** A `file:` icon Magpie uploaded for a provider, as opposed to one of its built-in glyphs. */
function isHostImageAsset(dataUrl: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/u.test(dataUrl)
}

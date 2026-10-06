/** 检查浏览器麦克风和实时语音流所需的安全上下文。 */
export interface BrowserVoiceSecurity {
  readonly secure: boolean
  readonly protocol: string
  readonly reason?: 'isSecureContext' | 'insecureProtocol' | 'unknown'
}

export function inspectBrowserVoiceSecurity(): BrowserVoiceSecurity {
  const environment = globalThis as typeof globalThis & {
    readonly window?: { readonly location?: Location; readonly isSecureContext?: boolean }
    readonly location?: Location
    readonly isSecureContext?: boolean
    readonly document?: Document
  }
  const windowLike = environment.window
  const location = windowLike?.location ?? environment.location
  const protocol = typeof location?.protocol === 'string' ? location.protocol.toLowerCase() : ''
  const hostname = typeof location?.hostname === 'string' ? location.hostname.toLowerCase() : ''
  const secureValue = typeof windowLike?.isSecureContext === 'boolean'
    ? windowLike.isSecureContext
    : typeof environment.isSecureContext === 'boolean' ? environment.isSecureContext : undefined
  const hasBrowserSurface = windowLike !== undefined || environment.document !== undefined || secureValue !== undefined || protocol !== ''
  if (!hasBrowserSurface) return { secure: true, protocol }
  if (secureValue === false) return { secure: false, protocol, reason: 'isSecureContext' }
  if (protocol === 'http:' && !isLoopbackHostname(hostname)) return { secure: false, protocol, reason: 'insecureProtocol' }
  if (secureValue === true || protocol === 'https:' || protocol === 'wss:' || protocol === 'file:' || protocol === 'chrome-extension:') return { secure: true, protocol }
  if (protocol === 'http:' && isLoopbackHostname(hostname)) return { secure: true, protocol }
  return { secure: false, protocol, reason: 'unknown' }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

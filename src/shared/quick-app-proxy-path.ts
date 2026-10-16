/** A launch-only bearer address; neither a DSH credential nor a workspace path. */
export const QUICK_APP_PROXY_PREFIX = '/__codingns/quick-apps/'
/** The native Desktop embedding origin; preview resources use the verified Host listener. */
export const QUICK_APP_DESKTOP_ORIGIN = 'dsh-app://app'
export function quickAppProxyBase(path: string): string | undefined {
  const base = /^\/__codingns\/quick-apps\/[A-Za-z0-9_-]{43}\//u.exec(path)?.[0]
  if (!base) return undefined
  // DSH matches URL-normalized paths. A raw prefix must never exempt a request
  // that normalization would move into a privileged API outside this prefix.
  try { return new URL(path, 'http://host.invalid').pathname.startsWith(base) ? base : undefined } catch { return undefined }
}

import {
  assertSupportedDshVersion,
  CODINGNS_DSH_ERROR_CODES,
  CODINGNS_DSH_VERSION_GLOBAL,
  CodingNsDshError,
} from '../shared/index.js'

type DshVersionGlobal = typeof globalThis & {
  [CODINGNS_DSH_VERSION_GLOBAL]?: unknown
}

/** 读取 Host 注入的真实 DSH 版本，并在无法读取时拒绝启用 Client。 */
export function assertInjectedDshVersion(): string {
  const value = (globalThis as DshVersionGlobal)[CODINGNS_DSH_VERSION_GLOBAL]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
      '无法读取当前 DSH 版本；为避免 Client API 不兼容，已拒绝启用 dsh-codingns',
    )
  }
  assertSupportedDshVersion(value)
  return value
}

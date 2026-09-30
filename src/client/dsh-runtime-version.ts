import {
  assertSupportedDshVersion,
  CODINGNS_DSH_ERROR_CODES,
  CODINGNS_DSH_VERSION_GLOBAL,
  CodingNsDshError,
  minimumSupportedDshVersion,
} from '../shared/index.js'
import type { Context } from '@deepseek-ai/cordis'

type DshVersionGlobal = typeof globalThis & {
  [CODINGNS_DSH_VERSION_GLOBAL]?: unknown
}

/**
 * 读取 Host 注入的真实 DSH 版本，并在无法读取时拒绝启用 Client。
 *
 * DSH 0.1.7 的设置服务迁移会让旧 Host 启动页注入钩子无法执行；此时
 * `configForms` 是新版 Client 唯一可靠的运行时标志。缺少注入时只能用
 * 兼容范围下界做保守回退，不能写死某个历史版本：范围一旦放宽，写死的版本
 * 会落在范围之外，把“只是没有注入”误报成“不支持的 DSH 版本”。
 */
export function assertInjectedDshVersion(ctx?: Context): string {
  const value = (globalThis as DshVersionGlobal)[CODINGNS_DSH_VERSION_GLOBAL]
  if (typeof value !== 'string' || value.trim() === '') {
    if (hasModernConfigForms(ctx)) {
      const fallbackVersion = minimumSupportedDshVersion()
      assertSupportedDshVersion(fallbackVersion)
      return fallbackVersion
    }
    throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
      '无法读取当前 DSH 版本；为避免 Client API 不兼容，已拒绝启用 codingns4dsh',
    )
  }
  assertSupportedDshVersion(value)
  return value
}

function hasModernConfigForms(ctx: Context | undefined): boolean {
  if (ctx === undefined) return false
  try {
    const forms = ctx.get('configForms') as { readonly get?: unknown } | undefined
    return typeof forms?.get === 'function'
  } catch {
    return false
  }
}

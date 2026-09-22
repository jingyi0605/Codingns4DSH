import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_SETTINGS,
  type CodingNsSettings,
} from '../shared/contracts/config.js'

/**
 * DSH 设置服务使用的 CodingNS namespace schema。
 *
 * 模块开关用字典表达：新增模块只是字典里多一个键，既不需要改这个 schema，
 * 也不需要改 CodingNsSettings 接口。
 */
export const CodingNsSettingsSchema: z<CodingNsSettings> = z.object({
  controlBaseUrl: z.string().default(DEFAULT_CODINGNS_SETTINGS.controlBaseUrl),
  modules: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.modules),
  lanAccessDsh: z.object({
    autoStart: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.autoStart),
    listenHost: z.string().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenHost),
    listenPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenPort),
    dshPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.dshPort),
  }).default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh),
})

/**
 * 在 Host 设置文档中注册 CodingNS 的持久化选项。
 *
 * 必须在已经注入 `settings` 的上下文里调用。返回的 scope 既用于读取当前值，
 * 也通过 watch 驱动功能模块启停。
 */
export function registerCodingNsSettings(ctx: Context): SettingsScope<CodingNsSettings> {
  const settings: SettingsProvider = ctx.settings
  return settings.register(CODINGNS_SETTINGS_NAMESPACE, CodingNsSettingsSchema, {
    applies: 'live',
  })
}

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
  controlBaseUrls: z.array(z.string()).default(DEFAULT_CODINGNS_SETTINGS.controlBaseUrls),
  modules: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.modules),
  agentAdapters: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.agentAdapters ?? {}),
  // 会话索引是 Host 摘要数据，不能让它进入浏览器状态或模型上下文。
  cliSessions: z.array(z.any()).default(DEFAULT_CODINGNS_SETTINGS.cliSessions ?? []),
  lanAccessDsh: z.object({
    autoStart: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.autoStart),
    listenHost: z.string().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenHost),
    listenPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenPort),
    dshPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.dshPort),
  }).default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh),
  terminalEnhancement: z.object({
    bindingScope: z.union([z.const('workspace'), z.const('session')])
      .default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.bindingScope ?? 'workspace'),
    defaultProfile: z.union([
      z.const('system'), z.const('zsh'), z.const('bash'),
      z.const('powershell'), z.const('cmd'), z.const('git-bash'),
    ]).default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.defaultProfile),
    appearance: z.object({
      theme: z.union([z.const('inherit'), z.const('custom')])
        .default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.appearance.theme),
      background: nullableColorSchema(),
      foreground: nullableColorSchema(),
      cursorColor: nullableColorSchema(),
      fontFamily: z.union([
        z.string().min(1).max(128).pattern(/^[^\u0000-\u001F\u007F]+$/u),
        z.const(null),
      ]).default(null),
      fontSize: nullableNumberSchema(10, 32),
      lineHeight: nullableNumberSchema(1, 2),
      cursorStyle: z.union([
        z.const('block'), z.const('bar'), z.const('underline'), z.const(null),
      ]).default(null),
      cursorBlink: z.union([z.boolean(), z.const(null)]).default(null),
      scrollback: z.union([z.number().step(1).min(1000).max(100000), z.const(null)]).default(null),
    }).default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.appearance),
  }).default({
    ...DEFAULT_CODINGNS_SETTINGS.terminalEnhancement,
    bindingScope: DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.bindingScope ?? 'workspace',
  }),
  workspaceSessionEnhancement: z.object({
    showAdapterLogo: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showAdapterLogo),
    showArchivedSessions: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showArchivedSessions),
  }).default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement),
})

/** 颜色字段只接受完整十六进制颜色，`null` 表示继承 DSH 原生值。 */
function nullableColorSchema(): z<string | null> {
  return z.union([z.string().pattern(/^#[0-9A-Fa-f]{6}$/u), z.const(null)]).default(null)
}

function nullableNumberSchema(min: number, max: number): z<number | null> {
  return z.union([z.number().min(min).max(max), z.const(null)]).default(null)
}

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

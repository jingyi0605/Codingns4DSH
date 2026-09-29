/** 启动页注入表中的全局变量记录。 */
import type { LanAccessDshPwaSettings } from '../shared/contracts/config.js'
import { createPwaClientScript } from './modules/pwa/index.js'

export interface DshIndexInjectionEntry {
  readonly kind?: unknown
  readonly name?: unknown
  readonly value?: unknown
  readonly [key: string]: unknown
}

/**
 * 在启动页声明 Host 所有权，让 ui-settings 对非回环页面（局域网直连、中继）
 * 保持 host 模式，同时保留 Desktop 已经提供的完整 Transport。
 *
 * 页面级 `__DSH_TRANSPORT__` 同时被 Desktop 壳、中继桥和这里写入，因此注入只做
 * 合并写、且只追加脚本行（kind: "script"）：
 *
 * - 不追加同名全局行。全局行由 DSH 在文档里直接赋值，一旦排在 Desktop 的行之后
 *   就会整体覆盖 Transport，丢掉 `streamBaseUrl`，让 `/api/remote.mux` 退回
 *   `ws://app` 并卡住插件页。
 * - 脚本行在客户端启动前执行：已有 Transport 时只补 `ownsHost`，没有 Transport
 *   且页面也不是 Desktop（`dshDesktopBoot` 未定义，Desktop 自己声明所有权）时
 *   才创建 `{ ownsHost: true }`。
 * - 未知形状（例如 Desktop 托管的字符串标记）保持原样，不被覆盖。
 */
export function injectDshWebTransportOwnership(table: unknown[]): void {
  const index = table.findIndex((entry) => isTransportInjection(entry))
  if (index >= 0) {
    const entry = table[index]
    if (!isRecord(entry) || !isRecord(entry.value)) return
    table[index] = { ...entry, value: { ...entry.value, ownsHost: true } }
  }

  table.push({ kind: 'script', placement: 'head', text: TRANSPORT_OWNERSHIP_SCRIPT })
}

/**
 * 在客户端读取 Transport 之前补齐 Host 所有权。
 *
 * 只做合并写和“无 Transport 时创建”，不覆盖任何已有字段；`dshDesktopBoot`
 * 存在时交给 Desktop 壳自己的 Transport（它已经带 `ownsHost`）。
 */
const TRANSPORT_OWNERSHIP_SCRIPT = [
  '(function(){',
  'var t=globalThis.__DSH_TRANSPORT__;',
  'if(t===void 0||t===null){if(globalThis.dshDesktopBoot===void 0)globalThis.__DSH_TRANSPORT__={ownsHost:true};return}',
  'if(typeof t==="object")t.ownsHost=true;',
  '})()',
].join('')

/** PWA 元数据标记；代理未覆盖 manifest 的入口上这些链接只会 404，属预期。 */
export const CODINGNS_PWA_METADATA_MARKUP = [
  '<meta name="theme-color" content="#0a0f1d" media="(prefers-color-scheme: dark)">',
  '<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="DSH">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/__codingns/pwa/apple-touch-icon.png">',
].join('')

/**
 * 追加移动端 PWA 元数据与注册脚本。
 *
 * 与 Transport 注入共用同一张表：元数据行排在前、脚本行排在后，二者都只在
 * `lanAccessDsh.pwa.enabled` 开启时出现。脚本自身会在回环地址短路，因此本机与
 * 桌面壳不会因此改变安装行为。
 */
export function injectDshWebPwaMetadata(table: unknown[], settings: LanAccessDshPwaSettings): boolean {
  if (!settings.enabled) return false
  table.push({ kind: 'html', placement: 'head', html: CODINGNS_PWA_METADATA_MARKUP })
  table.push({
    kind: 'script',
    placement: 'head',
    text: createPwaClientScript({ serviceWorker: settings.serviceWorker, installPrompt: settings.installPrompt }),
  })
  return true
}

function isTransportInjection(value: unknown): value is DshIndexInjectionEntry {
  return isRecord(value) && value.name === '__DSH_TRANSPORT__'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

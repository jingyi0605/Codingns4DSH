import type { LanAccessDshSnapshot, LanAccessDshState } from '../../shared/contracts/lan-access-dsh.js'
import { dshThemeColor } from '../theme.js'

/**
 * 「局域网访问 DSH」状态指示与访问地址的纯计算。
 *
 * 面板只负责渲染：状态语义、配色和可复制的 URL 都在这里算好，
 * 便于在无 DOM 环境下直接测试，避免把判断散进 createElement 树。
 */

/** 状态指示器的语义、配色与文案键；文案由调用方翻译。 */
export interface LanAccessStatusDescriptor {
  readonly state: LanAccessDshState
  /** 状态文案在 Codingns4DSH 词典中的键。 */
  readonly labelKey: string
  /** 状态主色，直接取 DSH 主题令牌。 */
  readonly color: string
  /** 是否处于“监听中”；只有该状态才有可访问的 URL。 */
  readonly listening: boolean
}

/** 监听全部网卡的写法；这些地址不能直接用于浏览器访问。 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0', '*'])

/**
 * 把运行快照映射成状态指示器语义。
 *
 * `null` 快照表示代理从未启动或已被停止；`starting` 与 `error` 只在
 * 启动流程中短暂出现，`error` 快照不会保留在 Host 侧。
 */
export function resolveLanAccessStatus(snapshot: LanAccessDshSnapshot | null): LanAccessStatusDescriptor {
  if (snapshot === null) {
    return { state: 'stopped', labelKey: 'lan.statusStopped', color: dshThemeColor.labelTertiary, listening: false }
  }
  switch (snapshot.state) {
    case 'starting':
      return { state: 'starting', labelKey: 'lan.statusStarting', color: dshThemeColor.accent, listening: false }
    case 'listening':
      return { state: 'listening', labelKey: 'lan.statusListening', color: dshThemeColor.success, listening: true }
    case 'error':
      return { state: 'error', labelKey: 'lan.statusError', color: dshThemeColor.error, listening: false }
    default:
      return { state: 'stopped', labelKey: 'lan.statusStopped', color: dshThemeColor.labelTertiary, listening: false }
  }
}

/**
 * 计算可复制、可在别的设备上打开的访问地址。
 *
 * 监听具体网卡时只有一个地址；监听 `0.0.0.0` 时用本机网卡地址逐条展开，
 * 避免给出 `http://0.0.0.0:13080` 这种在浏览器里没有意义的地址。
 * 拿不到任何网卡地址时退回监听地址本身，保证界面上仍能看到端口。
 */
export function buildLanAccessUrls(
  snapshot: LanAccessDshSnapshot | null,
  interfaceAddresses: readonly string[] = [],
): string[] {
  if (snapshot === null || snapshot.state !== 'listening') return []
  const port = snapshot.actualListenPort ?? snapshot.listenPort
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
  const listenHost = snapshot.listenHost.trim()
  if (listenHost === '') return []
  if (!WILDCARD_HOSTS.has(listenHost)) return [formatLanAccessUrl(listenHost, port)]
  const candidates = uniqueStrings(interfaceAddresses).filter(isReachableInterfaceAddress)
  if (candidates.length === 0) return [formatLanAccessUrl(listenHost, port)]
  return candidates.map((address) => formatLanAccessUrl(address, port))
}

/** 单个地址的 URL 形式；IPv6 需要方括号，否则端口会被当成地址的一部分。 */
export function formatLanAccessUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`
}

/**
 * 复制文本；非安全上下文（HTTP 局域网页面）没有 Clipboard 权限时回退到
 * 传统 DOM 复制接口，两者都失败才抛错。
 */
export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // 继续尝试兼容回退。
    }
  }
  if (copyTextWithExecCommand(value)) return
  throw new Error('浏览器不允许访问剪贴板')
}

function copyTextWithExecCommand(value: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function' || document.body === null) return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

/** 过滤回环、通配和链路本地地址：它们对局域网里的其它设备没有意义。 */
function isReachableInterfaceAddress(address: string): boolean {
  const value = address.trim()
  if (value === '' || WILDCARD_HOSTS.has(value)) return false
  if (value === '::1' || /^127\./u.test(value)) return false
  if (/^169\.254\./u.test(value)) return false
  if (/^fe80:/iu.test(value)) return false
  return true
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

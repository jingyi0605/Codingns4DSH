import type { Context } from '@deepseek-ai/cordis'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { normalizePeerHostFileLocation } from '../shared/peer-host-file-location.js'
import { readNativeService, readNativeWorkspaceSnapshot } from './native-workspace-store.js'

interface FileResourceOpenOptions {
  readonly params?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

interface FileResourceSidebar {
  openResource(address: string, options?: FileResourceOpenOptions): unknown
  openResourceIn?(sessionId: string, address: string, options?: FileResourceOpenOptions): unknown
}

/**
 * 在原生资源入口规范本地及远端链接，保留资源里的会话身份和导航参数。
 * 右栏文件树、消息与预览内链接共用这个入口；不扫描消息正文或当前选择。
 */
export function installSessionFileLinkRouting(
  uiContext: { get(name: string): unknown },
  workspacePathForSession: (sessionId: string) => string | undefined,
): (() => void) | undefined {
  const sidebar = uiContext.get('sidebarRight') as FileResourceSidebar | undefined
  if (typeof sidebar?.openResource !== 'function') return undefined
  const originalOpen = sidebar.openResource
  const originalOpenIn = sidebar.openResourceIn
  const resolve = (address: string, options: FileResourceOpenOptions | undefined): [string, FileResourceOpenOptions | undefined] => {
    const file = parseFileAddress(address)
    if (file?.scope !== 'session') return [address, options]
    const location = normalizePeerHostFileLocation(file.path, workspacePathForSession(file.sessionId))
    if (location.path === file.path) return [address, options]
    // 文件地址的查询/片段按原样保留，已有显式行号优先于路径里的位置后缀。
    const suffix = address.search(/[?#]/u)
    const normalized = sessionFileAddress(file.sessionId, location.path) + (suffix < 0 ? '' : address.slice(suffix))
    const navigation = location.line === undefined ? options : {
      ...options,
      params: { line: location.line, ...options?.params },
    }
    return [normalized, navigation]
  }
  const open: FileResourceSidebar['openResource'] = (address, options) => originalOpen.call(sidebar, ...resolve(address, options))
  const openIn: FileResourceSidebar['openResourceIn'] = originalOpenIn === undefined ? undefined
    : (sessionId, address, options) => originalOpenIn.call(sidebar, sessionId, ...resolve(address, options))
  sidebar.openResource = open
  if (openIn !== undefined) sidebar.openResourceIn = openIn
  return () => {
    // 只还原自身包装，避免卸载时覆盖其他扩展后来接入的入口。
    if (sidebar.openResource === open) sidebar.openResource = originalOpen
    if (openIn !== undefined && sidebar.openResourceIn === openIn) sidebar.openResourceIn = originalOpenIn!
  }
}

/** 独立于 PeerHost 开关，按资源所属会话的最新目录识别路径平台。 */
export function installNativeSessionFileLinkRouting(uiContext: Context): (() => void) | undefined {
  const sessions = readNativeService(uiContext, 'sessions', 'list') as {
    getSnapshot(): { readonly byId?: Readonly<Record<string, { readonly cwd?: string }>> }
  } | undefined
  return installSessionFileLinkRouting(uiContext, (sessionId) => {
    const workspace = readNativeWorkspaceSnapshot(uiContext)?.items.find((item) => item.sessionIds.includes(sessionId))
    // 远端空白会话的 cwd 可能是侧栏虚拟 URI，优先使用工作区保存的真实路径。
    return workspace?.workspacePath ?? sessions?.getSnapshot().byId?.[sessionId]?.cwd ?? workspace?.path
  })
}

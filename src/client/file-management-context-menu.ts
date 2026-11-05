import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { parseVirtualSessionId } from '../shared/contracts/peer-host.js'
import type { DshContextMenuAdapter, DshContextMenuAction } from '../dsh-capabilities/client/context-menu-adapter.js'
import { copyResolvedFilePath, resolveFileCopyPaths } from './file-management-dom.js'

interface FileTarget {
  readonly sessionId: string
  readonly path: string
}

interface ClipboardState {
  readonly mode: 'copy' | 'cut'
  readonly target: FileTarget
}

export interface FileManagementContextMenuController {
  setEnabled(enabled: boolean): void
  dispose(): void
}

/** Registers alpha.3 file actions while leaving the DOM menu as the old-host fallback. */
export function registerFileManagementContextMenus(
  rpc: CodingNsRpcClient,
  contextMenus: DshContextMenuAdapter | undefined,
  locale?: CodingNsLocale,
): FileManagementContextMenuController {
  if (contextMenus === undefined) return { setEnabled: () => undefined, dispose: () => undefined }
  const menuService = contextMenus
  const t = resolveCodingNsTranslator(locale)
  let enabled = false
  let clipboard: ClipboardState | undefined
  const disposers = [
    menuService.register({
      id: 'codingns.file-management.file',
      target: 'file',
      order: 400,
      resolve: (value, signal) => resolveFileActions(value, false, signal),
    }),
    menuService.register({
      id: 'codingns.file-management.directory',
      target: 'directory',
      order: 400,
      resolve: (value, signal) => resolveFileActions(value, true, signal),
    }),
  ]

  return {
    setEnabled(value) { enabled = value },
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }

  function resolveFileActions(value: unknown, directory: boolean, signal: AbortSignal): readonly DshContextMenuAction[] {
    if (!enabled || signal.aborted) return []
    const target = readTarget(value)
    if (target === undefined) return []
    const destination = directory ? target : { ...target, path: parentPath(target.path) }
    const workspaceRoot = workspaceRootForSession(target.sessionId)
    const paths = resolveFileCopyPaths({
      resourcePath: target.path,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    })
    const absoluteAvailable = paths?.absolute !== undefined && paths.absolute !== ''
    return [
      { id: 'download', label: t('fileMenu.download'), disabled: directory, run: () => directory ? undefined : downloadFile(target) },
      { id: 'newFile', label: t('fileMenu.newFile'), run: () => createEntry(destination, false) },
      { id: 'newDirectory', label: t('fileMenu.newDirectory'), run: () => createEntry(destination, true) },
      { id: 'rename', label: t('fileMenu.rename'), run: () => renameEntry(target) },
      { id: 'copy', label: t('fileMenu.copy'), run: () => { clipboard = { mode: 'copy', target } } },
      { id: 'cut', label: t('fileMenu.cut'), run: () => { clipboard = { mode: 'cut', target } } },
      {
        id: 'paste',
        label: t('fileMenu.paste'),
        disabled: clipboard === undefined || !sameFileHost(clipboard.target.sessionId, target.sessionId),
        run: () => pasteEntry(destination),
      },
      {
        id: 'copyRelativePath',
        label: t('fileMenu.copyRelativePath'),
        run: () => paths === undefined ? notify(t('fileMenu.unresolvedPath')) : copyResolvedFilePath(paths.relative, false, t),
      },
      {
        id: 'copyAbsolutePath',
        label: t('fileMenu.copyAbsolutePath'),
        disabled: !absoluteAvailable,
        run: () => paths === undefined ? notify(t('fileMenu.unresolvedPath')) : copyResolvedFilePath(paths.absolute, true, t),
      },
      { id: 'gitIgnore', label: t('fileMenu.gitIgnore'), run: () => runMutation('git-ignore', { ...target, paths: [target.path] }) },
      { id: 'delete', label: t('fileMenu.delete'), danger: true, separatorBefore: true, run: () => deleteEntry(target) },
    ]
  }

  async function createEntry(target: FileTarget, directory: boolean): Promise<void> {
    const name = window.prompt(t(directory ? 'fileMenu.promptNewDirectory' : 'fileMenu.promptNewFile'), '')?.trim()
    if (!name) return
    await runMutation(directory ? 'create-directory' : 'create-file', { ...target, path: joinPath(target.path, name) })
  }

  async function renameEntry(target: FileTarget): Promise<void> {
    const next = window.prompt(t('fileMenu.promptRename'), leaf(target.path))?.trim()
    if (!next || next === leaf(target.path)) return
    const destination = isAbsoluteLike(next) ? next : joinPath(parentPath(target.path), next)
    await runMutation('rename', { ...target, destination })
  }

  async function pasteEntry(target: FileTarget): Promise<void> {
    const source = clipboard
    if (source === undefined || !sameFileHost(source.target.sessionId, target.sessionId)) return
    await runMutation(source.mode === 'copy' ? 'copy' : 'move', {
      ...target, paths: [source.target.path], destination: target.path,
    })
    if (source.mode === 'cut' && clipboard === source) clipboard = undefined
  }

  async function deleteEntry(target: FileTarget): Promise<void> {
    if (!window.confirm(t('fileMenu.confirmDelete', { name: leaf(target.path) }))) return
    await runMutation('delete', { ...target, paths: [target.path] })
  }

  async function downloadFile(target: FileTarget): Promise<void> {
    try {
      const result = await call('download', target) as { contentBase64: string; fileName?: string; mimeType?: string }
      const blob = new Blob([decodeBase64(result.contentBase64)], { type: result.mimeType ?? 'application/octet-stream' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = result.fileName ?? leaf(target.path)
      document.body.append(link)
      link.click()
      link.remove()
      globalThis.setTimeout(() => URL.revokeObjectURL(link.href), 30_000)
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function runMutation(action: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await call(action, payload)
      refreshPanel(payload.sessionId)
      notify(t('fileMenu.operationDone'), true)
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function call(action: string, payload: unknown): Promise<unknown> {
    return callCodingNsRpc(rpc, `fileManagement/${action}`, payload)
  }

  function notify(message: string, success = false): void {
    menuService.notify(message, success)
  }
}

function readTarget(value: unknown): FileTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const target = value as Record<string, unknown>
  return typeof target.sessionId === 'string' && typeof target.path === 'string' && target.path !== ''
    ? { sessionId: target.sessionId, path: target.path }
    : undefined
}

function refreshPanel(sessionId: unknown): void {
  if (typeof document === 'undefined' || typeof sessionId !== 'string') return
  const panel = [...document.querySelectorAll<HTMLElement>('[data-sidebar-right-session]')]
    .find(item => item.getAttribute('data-sidebar-right-session') === sessionId)
  const reload = panel?.querySelector<HTMLButtonElement>('[data-files-reload]')
  reload?.click()
}

function workspaceRootForSession(sessionId: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  const scoped = [...document.querySelectorAll<HTMLElement>('[data-sidebar-right-session]')]
    .find(item => item.getAttribute('data-sidebar-right-session') === sessionId)
    ?.querySelector<HTMLElement>('[data-files-root]')
    ?.getAttribute('data-files-root')?.trim()
  return scoped || document.querySelector<HTMLElement>('[data-files-root]')?.getAttribute('data-files-root')?.trim() || undefined
}

function sameFileHost(left: string, right: string): boolean {
  return parseVirtualSessionId(left)?.hostId === parseVirtualSessionId(right)?.hostId
}

function parentPath(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path.slice(0, Math.max(index, 1)) : path.slice(0, index)
}

function leaf(path: string): string { return path.split(/[\\/]/u).filter(Boolean).pop() ?? path }
function isAbsoluteLike(path: string): boolean { return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) }
function joinPath(base: string, child: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]$/u, '')}${separator}${child.replace(/^[\\/]+/u, '')}`
}
function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

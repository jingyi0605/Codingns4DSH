import { createElement, Fragment, type ReactElement } from 'react'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import {
  copyResolvedFilePath,
  parseFileTarget,
  resolveFileCopyPaths,
} from './file-management-dom.js'

export const FILE_VIEWER_COPY_PATH_MENU_ID = 'codingns4dsh-copy-file-path'

/** 标签菜单 extras 在单测或 Slot 未注入 locale 时退回内置中文词典。 */
const FALLBACK_LOCALE = {
  bind: () => resolveCodingNsTranslator(undefined),
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
} as unknown as CodingNsLocale

interface FileTabCopyPathMenuProps {
  readonly tab: { readonly contentId?: string }
  readonly dismiss: () => void
  readonly locale?: CodingNsLocale
  readonly sessionId?: string
  readonly useResource?: (address: string) => { readonly value?: { readonly absolutePath?: string } }
}

interface FileCopyPathSlots {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: FileTabCopyPathMenuProps) => ReactElement | null): () => void
}

const tabMenuItemStyle = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 7px',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--dsw-radius-md)',
  cursor: 'pointer',
} as const

/** 在文件查看器标签的原生右键菜单末尾加入复制相对/绝对路径。 */
export function registerFileViewerCopyPathMenu(
  slots: FileCopyPathSlots | undefined,
  locale?: CodingNsLocale,
): () => void {
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => undefined
  try {
    return slots.inject('sidebar.right.tab.menu.item', () => slots.register({
      name: 'sidebar.right.tab.menu.item',
      id: FILE_VIEWER_COPY_PATH_MENU_ID,
      order: 80,
    }, function FileTabCopyPathMenu(props: FileTabCopyPathMenuProps) {
      return FileTabCopyPathMenuItems({ ...props, locale: props.locale ?? locale })
    }))
  } catch {
    return () => undefined
  }
}

export function FileTabCopyPathMenuItems(props: FileTabCopyPathMenuProps): ReactElement | null {
  const t = useCodingNsTranslator(props.locale ?? FALLBACK_LOCALE)
  const paths = fileCopyPathsForTab(props)
  if (paths === undefined) return null
  return createElement(Fragment, null,
    copyPathMenuItem(t, 'fileMenu.copyRelativePath', 'relative', () => {
      props.dismiss()
      void copyResolvedFilePath(paths.relative, false, t)
    }),
    copyPathMenuItem(t, 'fileMenu.copyAbsolutePath', 'absolute', () => {
      props.dismiss()
      void copyResolvedFilePath(paths.absolute, true, t)
    }),
  )
}

export function fileCopyPathsForTab(props: Pick<FileTabCopyPathMenuProps, 'tab' | 'sessionId' | 'useResource'>): ReturnType<typeof resolveFileCopyPaths> {
  const address = (props.tab.contentId ?? '').split(/[?#]/u)[0] ?? ''
  const parsed = parseFileTarget(address)
  if (parsed === undefined) return undefined
  return resolveFileCopyPaths({
    resourcePath: parsed.path,
    workspaceRoot: workspaceRootForSession(props.sessionId),
    resourceAbsolutePath: props.useResource?.(address)?.value?.absolutePath,
  })
}

function copyPathMenuItem(
  t: CodingNsTranslator,
  key: 'fileMenu.copyRelativePath' | 'fileMenu.copyAbsolutePath',
  kind: 'relative' | 'absolute',
  onSelect: () => void,
): ReactElement {
  return createElement('button', {
    type: 'button',
    role: 'menuitem',
    'data-file-copy-path': kind,
    style: tabMenuItemStyle,
    onMouseEnter: (event: { currentTarget: HTMLButtonElement }) => {
      event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
    },
    onMouseLeave: (event: { currentTarget: HTMLButtonElement }) => {
      event.currentTarget.style.background = 'transparent'
    },
    onClick: onSelect,
  }, t(key))
}

function workspaceRootForSession(sessionId: string | undefined): string | undefined {
  if (typeof document === 'undefined') return undefined
  if (sessionId !== undefined && sessionId !== '') {
    const scoped = document.querySelector(`[data-sidebar-right-session="${cssAttribute(sessionId)}"] [data-files-root]`)
      ?.getAttribute('data-files-root')?.trim()
    if (scoped) return scoped
  }
  return document.querySelector('[data-files-root]')?.getAttribute('data-files-root')?.trim() || undefined
}

function cssAttribute(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

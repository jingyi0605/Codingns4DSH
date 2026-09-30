import {
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Button,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { resolveChevronDownIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import { CodingNsWebTerminals, type WebTerminalId } from './model.js'
import { createTerminalSessionRecovery, type TerminalSidebarMountedSource, type TerminalSidebarRecoveryPort } from './recovery.js'
import { installTerminalStyles, terminalClass } from './styles.js'
import { CodingNsXtermView } from './xterm-view.js'
import { codingNsTranslator, useCodingNsTranslator, type CodingNsLocale } from '../locale.js'
import type { CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'

export const TERMINAL_PROVIDER_ID = 'codingns4dsh/terminal'
export const TERMINAL_KIND = 'terminal'

interface TerminalParams {
  readonly terminalId?: WebTerminalId
  readonly shellPath?: string
}

interface TerminalThemeSource {
  readonly getSnapshot: () => number
  readonly subscribe: (listener: () => void) => () => void
}

interface TerminalInjected {
  readonly webTerminals: CodingNsWebTerminals
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly theme: TerminalThemeSource
  readonly locale: CodingNsLocale
  readonly legacyCloseFallback: boolean
}

type TerminalTabProps = {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
} & TerminalInjected
type TerminalTitleProps = {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
} & Pick<TerminalInjected, 'webTerminals' | 'locale'>
/** alpha2 才导出的 guide entry owner 类型；本地重述字段以保持 rc3 源码可编译。 */
interface TerminalGuideEntryOwnerProps {
  readonly entryId: string
  readonly kind: string
  readonly title: string
  readonly description?: string
}
interface TerminalGuideProps extends TerminalGuideEntryOwnerProps {
  readonly sessionId: string
  readonly useTabInfo: () => SidebarRightTabInfo
  readonly webTerminals: CodingNsWebTerminals
  readonly recoverSession: (sessionId: string) => Promise<readonly unknown[]>
  readonly locale: CodingNsLocale
}

/** 注册终端类型及其所有公开 Sidebar Slot。 */
export function registerCodingNsTerminalUi(
  ctx: Context,
  webTerminals: CodingNsWebTerminals,
  settings: CodingNsSettingsStore<CodingNsSettings>,
): () => void {
  const disposers: Array<() => void> = []
  const t = codingNsTranslator(ctx.locale)
  const theme: TerminalThemeSource = {
    getSnapshot: () => ctx.theme.getTheme().revision,
    subscribe: (listener) => ctx.on('theme/change', listener),
  }
  const sidebarRight = ctx.sidebarRight as typeof ctx.sidebarRight & {
    readonly registerCloseHandler?: (
      kind: string,
      handler: (sessionId: string, tab: SidebarRightTabInfo['tab']) => void,
    ) => () => void
  }
  const registerCloseHandler = sidebarRight.registerCloseHandler
  // alpha2 提供多 Tab 元数据和关闭 API；rc3 没有这些字段，不能直接调用。
  const legacyCloseFallback = typeof registerCloseHandler !== 'function'
  const recoverySidebar = sidebarRight as unknown as TerminalSidebarRecoveryPort
  const supportsMultiple = readSidebarOpenTabs(recoverySidebar) !== undefined
  const recovery = createTerminalSessionRecovery(webTerminals, recoverySidebar, TERMINAL_KIND)
  disposers.push(installTerminalStyles())
  const tabDefinition = {
    id: TERMINAL_PROVIDER_ID,
    kind: TERMINAL_KIND,
    ...(supportsMultiple ? { multiple: true } : {}),
    priority: 'extension',
    title: () => t('terminal.title'),
    guide: [{
      id: 'new',
      order: 20,
      title: () => t('terminal.new'),
      description: () => t('terminal.description'),
      icon: TerminalGuideIcon,
    }],
  } as const
  disposers.push(ctx.sidebarRightTabs.register(tabDefinition))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, settings, theme, locale: ctx.locale, legacyCloseFallback }),
  }, TerminalBody)))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, locale: ctx.locale }),
  }, TerminalTitle)))
  disposers.push(ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, recoverSession: recovery.ensure, locale: ctx.locale }),
  }, TerminalGuide)))
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codingns4dsh-terminal-cleanup', order: 1000,
    inject: () => ({ webTerminals, locale: ctx.locale, sidebarRight: recoverySidebar, recoverSession: recovery.ensure }),
  }, TerminalCleanup)))
  if (typeof registerCloseHandler === 'function') disposers.push(registerCloseHandler.call(ctx.sidebarRight, TERMINAL_KIND, (sessionId, tab) => {
    const params = navigationParams(tab)
    webTerminals.close(String(sessionId), String(tab.id), tab.contentId, params.terminalId)
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function TerminalBody({ sessionId, useTabInfo, webTerminals, settings, theme, locale, legacyCloseFallback }: TerminalTabProps): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const params = terminalParams(info)
  const view = webTerminals.view(String(sessionId), String(info.tab.id), info.tab.contentId, params.terminalId, params.shellPath)
  const themeRevision = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
  useEffect(() => info.tab.visible ? view.mount() : undefined, [info.tab.visible, view])
  useEffect(() => {
    if (!legacyCloseFallback) return
    // rc3 没有显式关闭回调，只能利用 Tab 被移除时的 signal 回收对应 Host 终端。
    const close = (): void => {
      const nextParams = navigationParams(info.tab)
      webTerminals.close(String(sessionId), String(info.tab.id), info.tab.contentId, nextParams.terminalId)
    }
    if (info.tab.signal.aborted) close()
    else info.tab.signal.addEventListener('abort', close, { once: true })
    return () => info.tab.signal.removeEventListener('abort', close)
  }, [legacyCloseFallback, info.tab, sessionId, webTerminals])
  return info.tab.visible ? createElement(CodingNsXtermView, {
    view,
    settings,
    themeRevision,
    onNewTerminal: () => info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true }),
    t,
  }) : null
}

function TerminalTitle({ sessionId, useTabInfo, webTerminals, locale }: TerminalTitleProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const params = terminalParams(info)
  const view = webTerminals.view(String(sessionId), String(info.tab.id), info.tab.contentId, params.terminalId, params.shellPath)
  const state = useSyncExternalStore(view.state.subscribe.bind(view.state), view.state.getSnapshot.bind(view.state))
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(state.title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!editing) setTitle(state.title) }, [editing, state.title])
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])
  const beginEditing = (event: { stopPropagation: () => void; detail?: number }): void => {
    event.stopPropagation()
    if (event.detail === undefined || event.detail >= 2) setEditing(true)
  }
  return createElement(Fragment, undefined,
    createElement(TerminalIcon),
    editing
      ? createElement('input', {
        ref: input,
        value: title,
        maxLength: 120,
        'aria-label': t('terminal.title'),
        className: terminalClass.titleInput,
        onPointerDown: stopPropagation,
        onClick: stopPropagation,
        onDoubleClick: stopPropagation,
        onChange: (event: { currentTarget: { value: string } }) => setTitle(event.currentTarget.value),
        onBlur: () => { setEditing(false); void view.rename(title) },
        onKeyDown: (event: { key: string; currentTarget: { blur: () => void }; stopPropagation: () => void }) => {
          event.stopPropagation()
          if (event.key === 'Escape') { setTitle(state.title); event.currentTarget.blur() }
          else if (event.key === 'Enter') event.currentTarget.blur()
        },
      })
      : createElement('span', {
        className: terminalClass.title,
        onPointerDown: stopPropagation,
        onMouseDown: stopPropagation,
        onClick: beginEditing,
        onDoubleClick: beginEditing,
        title: t('terminal.rename'),
      }, state.title),
  )
}

function TerminalGuide({ sessionId, useTabInfo, webTerminals, recoverSession, title, description, locale }: TerminalGuideProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ShellMenuState>({ phase: 'loading' })
  useEffect(() => { void recoverSession(String(sessionId)).catch(() => undefined) }, [recoverSession, sessionId])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void webTerminals.launchShells(String(sessionId), controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState({
        phase: 'ready',
        shells: result.shells,
        ...(result.selectedShell === undefined ? {} : { selected: result.selectedShell }),
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ phase: 'failed', message: messageOf(cause) })
    })
    return () => controller.abort()
  }, [open, attempt, sessionId, webTerminals])

  return createElement('div', {
    className: terminalClass.guideEntry,
    'data-sidebar-right-guide-entry': TERMINAL_KIND,
  },
  createElement(Button, {
    variant: 'ghost',
    className: terminalClass.guideMain,
    onClick: () => info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true }),
  },
  createElement(TerminalGuideIcon, { size: description === undefined ? 22 : 26, className: terminalClass.guideIcon }),
  createElement('span', { className: terminalClass.guideText },
    createElement('span', { className: terminalClass.guideTitle }, title),
    description === undefined ? null : createElement('span', { className: terminalClass.guideDescription }, description),
  )),
  createElement(Menu, {
    open,
    portal: true,
    autoFocus: true,
    align: 'end',
    className: terminalClass.guideMenu,
    items: shellMenuItems(state, t),
    ...(state.phase === 'ready' && state.selected !== undefined ? { selectedId: state.selected } : {}),
    onClose: () => setOpen(false),
    onSelect: (path) => {
      if (state.phase === 'failed') {
        setState({ phase: 'loading' })
        setAttempt((value) => value + 1)
        return
      }
      if (state.phase !== 'ready') return
      webTerminals.selectShell(path)
      setOpen(false)
      info.tab.actions.openTab(TERMINAL_KIND, { params: { shellPath: path }, replaceTab: true })
    },
    anchor: createElement(Button, {
      variant: 'ghost',
      className: terminalClass.guideTrigger,
      'aria-label': t('terminal.selectShell'),
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => { setState({ phase: 'loading' }); setOpen((value) => !value) },
    }, createElement(resolveChevronDownIcon())),
  }))
}

type ShellMenuState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly shells: readonly { readonly path: string; readonly name: string }[]; readonly selected?: string }
  | { readonly phase: 'failed'; readonly message: string }

function shellMenuItems(state: ShellMenuState, t: ReturnType<typeof codingNsTranslator>): readonly MenuEntry[] {
  if (state.phase === 'loading') return [{ id: 'loading', label: t('terminal.loadingShell'), disabled: true }]
  if (state.phase === 'failed') return [
    { id: 'error', label: `${t('terminal.error')}: ${state.message}`, disabled: true },
    { id: 'retry', label: t('terminal.retry') },
  ]
  if (state.shells.length === 0) return [{ id: 'empty', label: t('terminal.noShell'), disabled: true }]
  return state.shells.map((shell) => ({ id: shell.path, label: shell.name }))
}

interface TerminalCleanupProps {
  readonly webTerminals: CodingNsWebTerminals
  readonly locale: CodingNsLocale
  readonly sidebarRight: TerminalSidebarRecoveryPort
  readonly recoverSession: (sessionId: string) => Promise<readonly unknown[]>
}

function TerminalCleanup({ webTerminals, locale, sidebarRight, recoverSession }: TerminalCleanupProps): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const openTabs = readSidebarOpenTabs(sidebarRight)
  const openTabSnapshot = useSyncExternalStore(
    openTabs?.subscribe ?? noSubscribe,
    openTabs?.getSnapshot ?? noOpenTabs,
    openTabs?.getSnapshot ?? noOpenTabs,
  )
  const remoteReady = useSyncExternalStore(
    webTerminals.remoteReadyState.subscribe.bind(webTerminals.remoteReadyState),
    webTerminals.remoteReadyState.getSnapshot.bind(webTerminals.remoteReadyState),
    webTerminals.remoteReadyState.getSnapshot.bind(webTerminals.remoteReadyState),
  )
  const mounted = readSidebarMounted(sidebarRight)
  const mountedSessionId = useSyncExternalStore(
    mounted?.subscribe ?? noSubscribe,
    mounted?.getSnapshot ?? noMountedSession,
    mounted?.getSnapshot ?? noMountedSession,
  )
  useEffect(() => {
    // 0.1.7 才提供 mounted 会话 observable；旧版本保留原有 Guide 挂载路径。
    if (!remoteReady || mounted === undefined) return
    const sessionIds = new Set(openTabSnapshot.map((tab) => String(tab.sessionId).trim()).filter(Boolean))
    if (mountedSessionId !== undefined) sessionIds.add(String(mountedSessionId).trim())
    for (const sessionId of sessionIds) void recoverSession(sessionId).catch(() => undefined)
  }, [openTabSnapshot, recoverSession, remoteReady, mountedSessionId])
  const failures = useSyncExternalStore(webTerminals.closeFailures.subscribe.bind(webTerminals.closeFailures), webTerminals.closeFailures.getSnapshot.bind(webTerminals.closeFailures))
  if (failures.length === 0) return null
  return createElement('div', { className: terminalClass.cleanupStack },
    ...failures.map((failure) => createElement('div', {
      key: String(failure.id),
      className: terminalClass.cleanupNotice,
      role: 'alert',
    },
    createElement('span', undefined, t('terminal.cleanupFailed', { title: failure.title, message: failure.message })),
    createElement('button', { type: 'button', onClick: () => webTerminals.retryClose(failure.id) }, t('terminal.retry')),
    )),
  )
}

function readSidebarOpenTabs(sidebarRight: TerminalSidebarRecoveryPort): TerminalSidebarRecoveryPort['openTabs'] | undefined {
  try { return sidebarRight.openTabs }
  catch { return undefined }
}

function readSidebarMounted(sidebarRight: TerminalSidebarRecoveryPort): TerminalSidebarMountedSource | undefined {
  try { return sidebarRight.mounted }
  catch { return undefined }
}

function noMountedSession(): undefined { return undefined }
const EMPTY_OPEN_TABS: readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] = []
function noOpenTabs(): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] { return EMPTY_OPEN_TABS }
function noSubscribe(): () => void { return () => undefined }

function terminalParams(info: SidebarRightTabInfo): TerminalParams {
  const params = info.tab.navigation.params
  return typeof params === 'object' && params !== null ? params as TerminalParams : {}
}

function navigationParams(tab: { readonly navigation?: { readonly params?: unknown } }): TerminalParams {
  const params = tab.navigation?.params
  return typeof params === 'object' && params !== null ? params as TerminalParams : {}
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function stopPropagation(event: { stopPropagation: () => void }): void { event.stopPropagation() }

function TerminalIcon(): ReactElement {
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'm3 4 4 4-4 4M9 12h4',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function TerminalGuideIcon({ size = 26, className }: { readonly size?: number | undefined; readonly className?: string | undefined }): ReactElement {
  return createElement('svg', { width: size, height: size, className, viewBox: '0 0 28 28', fill: 'none', 'aria-hidden': true },
    createElement('rect', { x: 3, y: 5, width: 22, height: 19, rx: 3, fill: '#17191d' }),
    createElement('path', {
      d: 'm8 10 4 4-4 4M15 18h5',
      stroke: '#fff',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    terminal: TerminalParams
  }
}

import {
  createElement,
  useEffect,
  useCallback,
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
import { CodingNsWebTerminals, type WebTerminalId, type WebTerminalInfo } from './model.js'
import { createTerminalSessionRecovery, type TerminalSidebarMountedSource, type TerminalSidebarRecoveryPort } from './recovery.js'
import { installTerminalStyles, terminalClass } from './styles.js'
import { CodingNsXtermView } from './xterm-view.js'
import { codingNsTranslator, useCodingNsTranslator, type CodingNsLocale } from '../locale.js'
import type { CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'

export const TERMINAL_PROVIDER_ID = 'codingns4dsh/terminal'
export const TERMINAL_KIND = 'terminal'

interface TerminalParams {
  readonly shellPath?: string
  /** 从空状态创建聚合页时的一次性意图。 */
  readonly autoCreate?: boolean
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
}

type TerminalTabProps = {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
} & TerminalInjected
type TerminalTitleProps = {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
} & Pick<TerminalInjected, 'locale'>
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
  const recoverySidebar = ctx.sidebarRight as unknown as TerminalSidebarRecoveryPort
  const recovery = createTerminalSessionRecovery(webTerminals, recoverySidebar, TERMINAL_KIND)
  disposers.push(installTerminalStyles())
  const tabDefinition = {
    id: TERMINAL_PROVIDER_ID,
    kind: TERMINAL_KIND,
    // 一个 Sidebar 页签代表整个工作区终端集合；终端实例在页内列表切换。
    multiple: false,
    priority: 'extension',
    title: () => t('terminal.title'),
    guide: [{ id: 'terminal', order: 20, title: () => t('terminal.title'), description: () => t('terminal.description'), icon: TerminalGuideIcon }],
  } as const
  disposers.push(ctx.sidebarRightTabs.register(tabDefinition))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, settings, theme, locale: ctx.locale }),
  }, TerminalBody)))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ locale: ctx.locale }),
  }, TerminalTitle)))
  disposers.push(ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, recoverSession: recovery.ensure, locale: ctx.locale }),
  }, TerminalGuide)))
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codingns4dsh-terminal-cleanup', order: 1000,
    inject: () => ({ webTerminals, locale: ctx.locale, sidebarRight: recoverySidebar, recoverSession: recovery.ensure }),
  }, TerminalCleanup)))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function TerminalBody({ sessionId, useTabInfo, webTerminals, settings, theme, locale }: TerminalTabProps): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const params = terminalParams(info)
  const revision = useSyncExternalStore(webTerminals.inventoryRevision.subscribe.bind(webTerminals.inventoryRevision), webTerminals.inventoryRevision.getSnapshot.bind(webTerminals.inventoryRevision))
  const themeRevision = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
  const [terminals, setTerminals] = useState<readonly WebTerminalInfo[]>([])
  const [selectedId, setSelectedId] = useState<WebTerminalId | undefined>()
  const [loading, setLoading] = useState(true)
  const autoCreated = useRef(false)

  const reload = useCallback(async (): Promise<readonly WebTerminalInfo[]> => {
    setLoading(true)
    try {
      const next = await webTerminals.refreshInventory(String(sessionId))
      setTerminals(next)
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id)
      return next
    } finally {
      setLoading(false)
    }
  }, [sessionId, webTerminals])

  useEffect(() => { void reload().catch(() => setLoading(false)) }, [reload, revision])
  useEffect(() => {
    if (!params.autoCreate || autoCreated.current || loading || terminals.length > 0) return
    autoCreated.current = true
    void webTerminals.createTerminal(String(sessionId), params.shellPath).then((info) => {
      setSelectedId(info.id)
      return reload()
    }).catch(() => { autoCreated.current = false })
  }, [loading, params.autoCreate, params.shellPath, reload, sessionId, terminals.length, webTerminals])
  useEffect(() => {
    if (loading || terminals.length > 0 || params.autoCreate) return
    info.tab.actions.close()
  }, [info.tab.actions, loading, params.autoCreate, terminals.length])

  const selected = terminals.find((item) => item.id === selectedId)
  const view = selected === undefined ? undefined : webTerminals.viewForTerminal(String(sessionId), selected.id, selected.shell.path)
  useEffect(() => info.tab.visible ? view?.mount() : undefined, [info.tab.visible, view])
  if (!info.tab.visible || selected === undefined || view === undefined) return null
  return createElement('section', { className: terminalClass.aggregateRoot },
    createElement('nav', { className: terminalClass.list, 'aria-label': t('terminal.title') },
      ...terminals.map((item) => createElement(TerminalListRow, {
        key: item.id,
        item,
        selected: item.id === selected.id,
        onSelect: () => setSelectedId(item.id),
        onClose: () => { void webTerminals.closeTerminal(String(sessionId), item.id).then(() => reload()) },
        onRename: async (title) => {
          const target = webTerminals.viewForTerminal(String(sessionId), item.id, item.shell.path)
          await target.rename(title)
          await reload()
        },
        t,
      })),
      createElement(Button, {
        variant: 'primary',
        size: 'sm',
        className: terminalClass.newButton,
        onClick: () => { void webTerminals.createTerminal(String(sessionId)).then((created) => { setSelectedId(created.id); return reload() }) },
      }, t('terminal.new')),
    ),
    createElement('div', { className: terminalClass.content }, view === undefined ? null : createElement(CodingNsXtermView, {
      view,
      settings,
      themeRevision,
      onNewTerminal: () => { void webTerminals.createTerminal(String(sessionId)).then((created) => { setSelectedId(created.id); return reload() }) },
      t,
    })),
  )
}

function TerminalTitle({ useTabInfo, locale }: TerminalTitleProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  return createElement('span', { className: terminalClass.title, 'aria-label': t('terminal.title') }, createElement(TerminalIcon), t('terminal.title'))
}

function TerminalListRow({ item, selected, onSelect, onClose, onRename, t }: {
  readonly item: WebTerminalInfo
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onClose: () => void
  readonly onRename: (title: string) => Promise<void>
  readonly t: ReturnType<typeof codingNsTranslator>
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  return createElement('div', { className: selected ? `${terminalClass.listRow} ${terminalClass.listRowSelected}` : terminalClass.listRow },
    editing
      ? createElement('input', {
        value: title,
        autoFocus: true,
        className: terminalClass.listInput,
        'aria-label': t('terminal.rename'),
        onChange: (event: { currentTarget: { value: string } }) => setTitle(event.currentTarget.value),
        onBlur: () => { setEditing(false); void onRename(title) },
        onKeyDown: (event: { key: string; currentTarget: { blur: () => void }; stopPropagation: () => void }) => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur() },
      })
      : createElement('button', { type: 'button', className: terminalClass.listSelect, onClick: onSelect, onDoubleClick: () => setEditing(true) },
        createElement('span', undefined, item.title),
        createElement('small', undefined, item.shell.name),
      ),
    createElement('button', { type: 'button', className: terminalClass.listClose, 'aria-label': t('terminal.close'), onClick: onClose }, '×'),
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
    onClick: () => info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true, params: { autoCreate: true } }),
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
      info.tab.actions.openTab(TERMINAL_KIND, {
        params: { autoCreate: true, shellPath: path },
        replaceTab: true,
      })
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
  const inventoryRevision = useSyncExternalStore(
    webTerminals.inventoryRevision.subscribe.bind(webTerminals.inventoryRevision),
    webTerminals.inventoryRevision.getSnapshot.bind(webTerminals.inventoryRevision),
    webTerminals.inventoryRevision.getSnapshot.bind(webTerminals.inventoryRevision),
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
  }, [openTabSnapshot, recoverSession, remoteReady, mountedSessionId, inventoryRevision])
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

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
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

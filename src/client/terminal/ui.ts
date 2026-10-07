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
import type { CodingNsTerminalEnvironment } from '../../shared/contracts/terminal.js'
import {
  resolveChevronDownIcon,
  resolvePlusIcon,
  resolveRefreshIcon,
  resolveShortcutKeys,
  resolveTerminalArrowIcon,
  resolveToolIcon,
  resolveDelegateIcon,
} from '../../dsh-capabilities/client/primitives-adapter.js'
import { CodingNsWebTerminals, type WebTerminalInfo } from './model.js'
import { createTerminalSessionRecovery, type TerminalSidebarMountedSource, type TerminalSidebarRecoveryPort } from './recovery.js'
import { installTerminalStyles, terminalClass } from './styles.js'
import { CodingNsXtermView } from './xterm-view.js'
import { codingNsTranslator, useCodingNsTranslator, type CodingNsLocale } from '../locale.js'
import type { CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import { assertInjectedDshVersion } from '../dsh-runtime-version.js'
import type { TerminalSharingBridge } from '../../dsh-capabilities/client/terminal-sharing-adapter.js'
import type { TerminalTextSnapshot } from '../../shared/contracts/terminal-share.js'
import { TerminalSharing } from './sharing.js'
import { TerminalShareMenu } from './share-menu.js'
import { TerminalLogPreview } from './log-preview.js'

export const TERMINAL_PROVIDER_ID = 'codingns4dsh/terminal'
export const TERMINAL_KIND = 'terminal'
const AUTO_CREATE_INTENT_TTL_MS = 5000
const pendingAutoCreateSessions = new Map<string, number>()
/** 已消费的导航意图按会话保留，避免切换会话后旧 autoCreate 再次触发创建。 */
const consumedAutoCreateNavigations = new Map<string, string>()

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
  readonly sharing: TerminalSharing
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
  readonly openWorkspaceCard: (sessionId: string) => void
  readonly locale: CodingNsLocale
}

/** 注册终端类型及其所有公开 Sidebar Slot。 */
export function registerCodingNsTerminalUi(
  ctx: Context,
  webTerminals: CodingNsWebTerminals,
  settings: CodingNsSettingsStore<CodingNsSettings>,
): () => void {
  const disposers: Array<() => void> = []
  const sharing = new TerminalSharing(codingNsTranslator(ctx.locale))
  disposers.push(() => sharing.dispose())
  // 草稿服务单独注入，缺失时只影响分享入口，终端仍按原链路工作。
  const shareFiber = ctx.inject(['sessions', 'conversation', 'uiWorkspace', 'workspaces'], (shareCtx) => {
    const profile = createDshCapabilityRegistry(assertInjectedDshVersion(ctx), 'client', shareCtx).getProfile(shareCtx)
    const resolution = profile.capabilities.get('conversation.draft-share')
    if (resolution?.value === undefined) return
    shareCtx.effect(() => sharing.attachBridge(resolution.value as TerminalSharingBridge), 'codingns4dsh: terminal sharing')
    shareCtx.inject(['inputTriggers'], (referenceCtx) => {
      referenceCtx.effect(() => sharing.attachReferences(), 'codingns4dsh: terminal references')
    })
  })
  disposers.push(() => { void shareFiber.dispose() })
  const t = codingNsTranslator(ctx.locale)
  const theme: TerminalThemeSource = {
    getSnapshot: () => ctx.theme.getTheme().revision,
    subscribe: (listener) => ctx.on('theme/change', listener),
  }
  const recoverySidebar = ctx.sidebarRight as unknown as TerminalSidebarRecoveryPort
  const recovery = createTerminalSessionRecovery(webTerminals, recoverySidebar, TERMINAL_KIND, hasPendingAutoCreateIntent)
  disposers.push(installTerminalStyles())
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codingns4dsh-terminal-log-preview', order: 1001,
    inject: () => ({ sharing, locale: ctx.locale }),
  }, TerminalLogPreview)))
  const tabDefinition = {
    id: TERMINAL_PROVIDER_ID,
    kind: TERMINAL_KIND,
    // 一个 Sidebar 页签代表整个工作区终端集合；终端实例在页内列表切换。
    multiple: false,
    // 聚合页隐藏时仍保留所有 XtermView 和 Host follow，重新打开只需切换可见性。
    keepMounted: true,
    priority: 'extension',
    title: () => t('terminal.title'),
    guide: [{ id: 'terminal', order: 20, title: () => t('terminal.title'), description: () => t('terminal.description'), icon: TerminalGuideIcon }],
  } as const
  disposers.push(ctx.sidebarRightTabs.register(tabDefinition))
  if (typeof recoverySidebar.registerCloseHandler === 'function') {
    disposers.push(recoverySidebar.registerCloseHandler(TERMINAL_KIND, (sessionId, tab) => recovery.close(String(sessionId), tab.id)))
  }
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, settings, theme, sharing, locale: ctx.locale }),
  }, CodingNsTerminalAggregateBody)))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ locale: ctx.locale }),
  }, TerminalTitle)))
  disposers.push(ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, recoverSession: recovery.ensure, openWorkspaceCard: recovery.open, locale: ctx.locale }),
  }, TerminalGuide)))
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codingns4dsh-terminal-cleanup', order: 1000,
    inject: () => ({
      webTerminals,
      locale: ctx.locale,
      sidebarRight: recoverySidebar,
      recoverSession: recovery.ensure,
      invalidateRecovery: recovery.invalidate,
    }),
  }, TerminalCleanup)))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** 聚合终端页使用独立组件名，避免 HMR 把旧单终端 TerminalBody 的 Hook 树复用过来。 */
function CodingNsTerminalAggregateBody({ sessionId, useTabInfo, webTerminals, settings, theme, locale, sharing }: TerminalTabProps): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const params = terminalParams(info)
  const navigationKey = terminalNavigationKey(info, String(sessionId))
  // recovery 创建的聚合页也会有 navigation revision，但那只是页签导航版本，
  // 不能把它当成“新建终端”命令。创建只能由明确参数或 Guide 写入的一次性意图触发。
  const hasAutoCreateIntent = params.autoCreate === true || hasPendingAutoCreateIntent(String(sessionId))
  const autoCreate = hasAutoCreateIntent && consumedAutoCreateNavigations.get(String(sessionId)) !== navigationKey
  const revision = useSyncExternalStore(webTerminals.inventoryRevision.subscribe.bind(webTerminals.inventoryRevision), webTerminals.inventoryRevision.getSnapshot.bind(webTerminals.inventoryRevision))
  const themeRevision = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
  // 会话只定位工作区；库存和选择都由工作区共享，切换会话不会重置子标签。
  const terminals = webTerminals.inventoryForSession(String(sessionId))
  const selectedId = useSyncExternalStore(
    webTerminals.selectionRevision.subscribe.bind(webTerminals.selectionRevision),
    () => webTerminals.selectedTerminalId(String(sessionId)),
  )
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [shareSnapshot, setShareSnapshot] = useState<TerminalTextSnapshot>()
  const [shareError, setShareError] = useState('')
  const closeShare = useCallback(() => setShareSnapshot(undefined), [])
  const [heldModifiers, setHeldModifiers] = useState<TerminalHeldModifiers>(EMPTY_HELD_MODIFIERS)
  /** React 状态更新前可能收到连续点击；用同步锁保证只发出一个 create 请求。 */
  const creatingRef = useRef(false)
  const refreshingRef = useRef(false)
  const autoCreatedFor = useRef<string | undefined>(undefined)
  const reloadSequence = useRef(0)

  const reload = useCallback(async (): Promise<readonly WebTerminalInfo[]> => {
    const sequence = reloadSequence.current + 1
    reloadSequence.current = sequence
    setLoading(true)
    try {
      return await webTerminals.refreshInventory(String(sessionId))
    } finally {
      if (sequence === reloadSequence.current) setLoading(false)
    }
  }, [sessionId, webTerminals])

  const createNewTerminal = useCallback(async (): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(undefined)
    debugInfo('codingns4dsh: client terminal aggregate create begin', { sessionId: String(sessionId), shellPath: params.shellPath ?? null })
    try {
      const info = await webTerminals.createTerminal(String(sessionId), params.shellPath)
      await reload()
      // 创建成功后再消费本地意图。创建期间 recovery 仍需看到它，避免空列表
      // 的迟到响应把正在创建的聚合页关闭。
      pendingAutoCreateSessions.delete(String(sessionId))
      debugInfo('codingns4dsh: client terminal aggregate create success', { sessionId: String(sessionId), terminalId: info.id })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setCreateError(message)
      debugWarn('codingns4dsh: client terminal aggregate create failed', { sessionId: String(sessionId), error: message })
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [params.shellPath, reload, sessionId, webTerminals])

  useEffect(() => { void reload().catch(() => setLoading(false)) }, [reload, revision])
  useEffect(() => {
    // 创建失败后保留错误状态，等待用户显式重试，避免 effect 在失败后无限重复 create。
    if (!autoCreate || autoCreatedFor.current === navigationKey || loading || creating || createError !== undefined || terminals.length > 0) return
    // autoCreate 是打开当前聚合页时的一次性导航意图。创建成功后必须保持已消费状态，
    // 否则用户关闭最后一个终端使库存变空时，effect 会把它误当成首次打开并再次创建。
    autoCreatedFor.current = navigationKey
    consumedAutoCreateNavigations.set(String(sessionId), navigationKey)
    void createNewTerminal()
  }, [autoCreate, createError, createNewTerminal, creating, loading, navigationKey, sessionId, terminals.length])
  const selected = terminals.find((item) => item.id === selectedId)
  // 库存刷新删除当前项时，选择记录的修正和库存更新不一定同一帧完成。
  // 先用首项作为 active，避免短暂渲染空状态导致所有 view 卸载并重新连接。
  const activeId = selected?.id ?? terminals[0]?.id
  const activeView = activeId === undefined
    ? undefined
    : webTerminals.viewForTerminal(String(sessionId), activeId, terminals.find((item) => item.id === activeId)?.shell.path)
  const activePlatform = useSyncExternalStore(
    activeView?.state.subscribe.bind(activeView.state) ?? noSubscribe,
    () => activeView?.state.getSnapshot().environment?.platform,
    () => activeView?.state.getSnapshot().environment?.platform,
  )
  const refreshTerminal = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      // 工具栏刷新是显式动作：强制重建 follow，避免保活连接卡死时刷新无效。
      await Promise.all([reload(), activeView?.refresh({ force: true })])
    } catch (cause) {
      debugWarn('codingns4dsh: client terminal toolbar refresh failed', { sessionId: String(sessionId), error: messageOf(cause) })
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [activeView, reload, sessionId])
  // 聚合页声明 keepMounted 后，隐藏页签仍必须保留列表和每个 XtermView。
  // DSH 会隐藏外层 pane；这里把 visible 只传给视图作为 attach 生命周期信号，
  // 不能直接返回 null，否则切回页签会重新创建 DOM 并重新 follow。
  // DSH 0.2.x 的保留页签会复用旧终端页的 div 根节点。沿用 div 形状，
  // 让升级后的聚合布局在旧页签实例上也能正常完成 React reconciliation。
  const navigation = createElement('div', { className: terminalClass.listDock },
    createElement('nav', { className: terminalClass.list, 'aria-label': t('terminal.title') },
      createElement('div', { className: terminalClass.listTabs },
        ...terminals.map((item) => createElement(TerminalListRow, {
          key: item.id,
          item,
          selected: item.id === activeId,
          onSelect: () => webTerminals.selectTerminal(String(sessionId), item.id),
          onClose: () => { void webTerminals.closeTerminal(String(sessionId), item.id).then(() => reload()) },
          onRename: async (title) => {
            const target = webTerminals.viewForTerminal(String(sessionId), item.id, item.shell.path)
            await target.rename(title)
            await reload()
          },
          t,
        })),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          className: terminalClass.newButton,
          icon: createElement(resolvePlusIcon()),
          'aria-label': t('terminal.new'),
          title: t('terminal.new'),
          disabled: creating,
          onClick: () => { void createNewTerminal() },
        }),
      ),
      createElement('div', { className: terminalClass.listActions },
        createElement(TerminalShareMenu, { sharing, snapshot: shareSnapshot, sessionId: String(sessionId), t, onClose: closeShare,
          anchor: createElement(Button, {
            variant: 'ghost', size: 'sm', className: terminalClass.shareButton,
            icon: createElement(resolveDelegateIcon(), { size: 16 }),
            'aria-label': t('terminalShare.title'), title: t('terminalShare.title'), disabled: activeView === undefined,
            'aria-haspopup': 'menu', 'aria-expanded': shareSnapshot !== undefined,
            onClick: () => {
              if (shareSnapshot !== undefined) { closeShare(); return }
              if (activeView === undefined) return
              if (!sharing.isReady()) { setShareError(t('terminalShare.unavailable')); return }
              try { setShareError(''); setShareSnapshot(sharing.capture(activeView)) }
              catch (cause) { setShareError(messageOf(cause)) }
            },
          }) }),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          className: terminalClass.refreshButton,
          icon: createElement(resolveRefreshIcon(), { size: 16 }),
          'aria-label': t('terminal.refresh'),
          title: t('terminal.refresh'),
          disabled: refreshing,
          onClick: () => { void refreshTerminal() },
        }),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          className: terminalClass.toolsButton,
          icon: createElement(resolveToolIcon(), { size: 16 }),
          'aria-label': t('terminal.tools'),
          title: t('terminal.tools'),
          'aria-haspopup': 'true',
          'aria-expanded': toolsOpen,
          onClick: () => setToolsOpen((value) => !value),
        }),
      ),
    ),
    toolsOpen ? createElement(TerminalToolsPanel, {
      view: activeView,
      platform: activePlatform,
      heldModifiers,
      onToggleModifier: (modifier) => setHeldModifiers((current) => ({ ...current, [modifier]: !current[modifier] })),
      t,
    }) : null,
  )
  const content = createElement('div', { className: terminalClass.content }, terminals.length === 0
      ? createElement('div', { role: 'status', className: terminalClass.empty },
        createElement('p', undefined, createError ?? (creating ? t('terminalView.starting') : t('terminal.description'))),
        createError === undefined ? null : createElement(Button, { variant: 'primary', size: 'sm', onClick: () => { void createNewTerminal() } }, t('terminal.retry')),
      )
      : terminals.map((item) => createElement(CodingNsXtermView, {
        key: item.id,
        view: webTerminals.viewForTerminal(String(sessionId), item.id, item.shell.path),
        settings,
        themeRevision,
        active: item.id === activeId,
        visible: info.tab.visible,
        onNewTerminal: () => { void createNewTerminal() },
        sharing,
        sessionId: String(sessionId),
        t,
      }))
  )
  const aggregateElement = createElement('div', { className: `${terminalClass.aggregateRoot} ${terminalClass.content}` }, navigation,
    shareError === '' ? null : createElement('div', { role: 'alert', className: terminalClass.error }, shareError), content)
  return aggregateElement
}

type TerminalModifier = 'ctrl' | 'alt' | 'win'
type TerminalPlatform = NonNullable<CodingNsTerminalEnvironment['platform']>
type TerminalToolCommand = 'tab' | 'escape' | 'enter' | 'backspace' | 'up' | 'down' | 'left' | 'right' | 'c' | 'd' | 'l' | 'z'
type TerminalHeldModifiers = Readonly<Record<TerminalModifier, boolean>>

const EMPTY_HELD_MODIFIERS: TerminalHeldModifiers = { ctrl: false, alt: false, win: false }

function TerminalToolsPanel({ view, platform, heldModifiers, onToggleModifier, t }: {
  readonly view: ReturnType<CodingNsWebTerminals['viewForTerminal']> | undefined
  readonly platform: TerminalPlatform | undefined
  readonly heldModifiers: TerminalHeldModifiers
  readonly onToggleModifier: (modifier: TerminalModifier) => void
  readonly t: ReturnType<typeof codingNsTranslator>
}): ReactElement {
  const modifier = (kind: TerminalModifier, label: string): ReactElement => createElement(Button, {
    key: kind,
    variant: 'toolbar',
    size: 'sm',
    className: `${terminalClass.toolAction} ${heldModifiers[kind] ? terminalClass.toolModifierActive : ''}`,
    'aria-label': label,
    title: label,
    'aria-pressed': heldModifiers[kind],
    disabled: view === undefined,
    onClick: () => onToggleModifier(kind),
  }, createElement(resolveShortcutKeys(), { keys: [terminalModifierKey(kind, platform)] }))
  const command = (kind: TerminalToolCommand, label: string): ReactElement => createElement(Button, {
    key: kind,
    variant: 'toolbar',
    size: 'sm',
    className: terminalClass.toolAction,
    'aria-label': label,
    title: label,
    disabled: view === undefined,
    onClick: () => { if (view !== undefined) view.write(terminalShortcutData(kind, heldModifiers)) },
  }, terminalToolControl(kind))
  return createElement('div', { className: terminalClass.toolsPanel, role: 'toolbar', 'aria-label': t('terminal.tools') },
    modifier('ctrl', terminalModifierLabel('ctrl', platform, t)),
    modifier('alt', terminalModifierLabel('alt', platform, t)),
    modifier('win', terminalModifierLabel('win', platform, t)),
    command('tab', t('terminal.shortcutTab')),
    command('escape', t('terminal.shortcutEscape')),
    command('enter', t('terminal.shortcutEnter')),
    command('backspace', t('terminal.shortcutBackspace')),
    command('up', t('terminal.shortcutUp')),
    command('down', t('terminal.shortcutDown')),
    command('left', t('terminal.shortcutLeft')),
    command('right', t('terminal.shortcutRight')),
    command('c', t('terminal.shortcutC')),
    command('d', t('terminal.shortcutD')),
    command('l', t('terminal.shortcutL')),
    command('z', t('terminal.shortcutZ')),
  )
}

function terminalModifierKey(modifier: TerminalModifier, platform: TerminalPlatform | undefined): string {
  if (modifier === 'alt' && platform === 'darwin') return 'Option'
  if (modifier !== 'win') return modifier === 'ctrl' ? 'Ctrl' : 'Alt'
  if (platform === 'darwin') return 'Cmd'
  if (platform === 'linux') return 'Super'
  return 'Win'
}

function terminalModifierLabel(modifier: TerminalModifier, platform: TerminalPlatform | undefined, t: ReturnType<typeof codingNsTranslator>): string {
  if (modifier === 'ctrl') return t('terminal.holdCtrl')
  if (modifier === 'alt' && platform === 'darwin') return t('terminal.holdOption')
  if (modifier === 'win' && platform === 'darwin') return t('terminal.holdCommand')
  if (modifier === 'win' && platform === 'linux') return t('terminal.holdSuper')
  if (modifier === 'alt') return t('terminal.holdAlt')
  return t('terminal.holdWin')
}

function terminalToolControl(command: TerminalToolCommand): ReactElement {
  if (command === 'up' || command === 'down' || command === 'left' || command === 'right') {
    return createElement(resolveTerminalArrowIcon(command), { size: 16 })
  }
  const label: Record<Exclude<TerminalToolCommand, 'up' | 'down' | 'left' | 'right'>, string> = {
    tab: 'Tab',
    escape: 'Esc',
    enter: 'Enter',
    backspace: '⌫',
    c: 'C',
    d: 'D',
    l: 'L',
    z: 'Z',
  }
  return createElement(resolveShortcutKeys(), { keys: [label[command]] })
}

function terminalShortcutData(command: TerminalToolCommand, modifiers: TerminalHeldModifiers): string {
  const base: Record<TerminalToolCommand, string> = {
    tab: '\t',
    escape: '\x1b',
    enter: '\r',
    backspace: '\x7f',
    up: '\x1b[A',
    down: '\x1b[B',
    left: '\x1b[D',
    right: '\x1b[C',
    c: 'c',
    d: 'd',
    l: 'l',
    z: 'z',
  }
  let value = base[command]
  if (modifiers.ctrl && /^[a-z]$/u.test(command)) value = String.fromCharCode(command.charCodeAt(0) - 96)
  if (modifiers.alt || modifiers.win) value = `\x1b${value}`
  return value
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
    createElement('button', {
      type: 'button',
      className: terminalClass.listClose,
      'aria-label': t('terminal.close'),
      // 阻止点击子终端关闭按钮冒泡到 DSH 外层页签，避免误关聚合页。
      onClick: (event: { stopPropagation: () => void; preventDefault: () => void }) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      },
    }, '×'),
  )
}

function TerminalGuide({ sessionId, useTabInfo, webTerminals, recoverSession, openWorkspaceCard, title, description, locale }: TerminalGuideProps): ReactElement {
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
    // Tab actions 的 replaceTab 是布尔开关；传 true 由 DSH 自动绑定当前标签 ID。
    onClick: () => {
      openWorkspaceCard(String(sessionId))
      markPendingAutoCreateIntent(String(sessionId))
      info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true, params: { autoCreate: true } })
    },
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
      openWorkspaceCard(String(sessionId))
      markPendingAutoCreateIntent(String(sessionId))
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
  readonly invalidateRecovery: (sessionId: string) => void
}

function TerminalCleanup({ webTerminals, locale, sidebarRight, recoverSession, invalidateRecovery }: TerminalCleanupProps): ReactElement | null {
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
  const cardRevision = useSyncExternalStore(
    webTerminals.cardRevision.subscribe.bind(webTerminals.cardRevision),
    webTerminals.cardRevision.getSnapshot.bind(webTerminals.cardRevision),
  )
  const mounted = readSidebarMounted(sidebarRight)
  const mountedSessionId = useSyncExternalStore(
    mounted?.subscribe ?? noSubscribe,
    mounted?.getSnapshot ?? noMountedSession,
    mounted?.getSnapshot ?? noMountedSession,
  )
  const previousInventoryRevision = useRef(inventoryRevision)
  useEffect(() => {
    // 0.1.7 才提供 mounted 会话 observable；旧版本保留原有 Guide 挂载路径。
    if (!remoteReady || mounted === undefined) return
    const inventoryChanged = previousInventoryRevision.current !== inventoryRevision
    previousInventoryRevision.current = inventoryRevision
    const sessionIds = new Set(openTabSnapshot.map((tab) => String(tab.sessionId).trim()).filter(Boolean))
    if (mountedSessionId !== undefined) sessionIds.add(String(mountedSessionId).trim())
    for (const sessionId of sessionIds) {
      if (inventoryChanged) invalidateRecovery(sessionId)
      void recoverSession(sessionId).catch(() => undefined)
    }
  }, [openTabSnapshot, recoverSession, remoteReady, mountedSessionId, inventoryRevision, cardRevision, invalidateRecovery])
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
  // DSH 0.2.x 的 navigation 是 SnapshotStore，参数位于 getSnapshot() 返回值；
  // 旧版适配层可能仍直接暴露 params，因此保留直接读取作为兼容兜底。
  const navigation = info.tab.navigation as unknown
  const snapshot = isRecord(navigation) && typeof navigation.getSnapshot === 'function'
    ? navigation.getSnapshot()
    : navigation
  const params = isRecord(snapshot) ? snapshot.params : undefined
  return isRecord(params) ? params as TerminalParams : {}
}

function terminalNavigationKey(info: SidebarRightTabInfo, sessionId: string): string {
  // TabRecord.id 在同一页签生命周期内稳定；导航 revision 会因 recovery
  // 或重新聚焦而递增，不能用它判断是否应再次创建 Host 终端。
  const tab = info.tab as unknown as { readonly id?: unknown }
  const tabId = typeof tab.id === 'string' ? tab.id : ''
  return `${sessionId}:${tabId}`
}

function markPendingAutoCreateIntent(sessionId: string): void {
  pendingAutoCreateSessions.set(sessionId, Date.now())
}

function hasPendingAutoCreateIntent(sessionId: string): boolean {
  const createdAt = pendingAutoCreateSessions.get(sessionId)
  if (createdAt === undefined) return false
  if (Date.now() - createdAt > AUTO_CREATE_INTENT_TTL_MS) {
    pendingAutoCreateSessions.delete(sessionId)
    return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DEFAULT_QUICK_PHRASES, type CodingNsSettings, type QuickPhrase } from '../shared/contracts/config.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { applyQuickPhraseOrder, matchesDshCssModuleClass, QUICK_PHRASE_FALLBACK_MARGIN, QUICK_PHRASE_PERMISSION_ORDER, QUICK_PHRASE_TRIGGER_ORDER, readQuickPhraseMargin } from './quick-phrase-layout.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'

const QUICK_PHRASE_FALLBACK_SIZE = 28
const QUICK_PHRASE_FALLBACK_ICON_SIZE = 14
const QUICK_PHRASE_STYLE_ID = 'codingns4dsh-quick-phrase-responsive-style'
/** 用属性选择器粗筛带 `_add` 类名的按钮，精确匹配再交给 matchesDshCssModuleClass。 */
const ADD_BUTTON_CANDIDATE_SELECTOR = 'button[class*="_add"]'

/** 移动端弹层脱离对话窗口边界，使用整个视口宽度。 */
function installQuickPhraseStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${QUICK_PHRASE_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = QUICK_PHRASE_STYLE_ID
  style.textContent = [
    '@media (max-width: 768px){.codingns4dsh-quick-phrase-overlay{left:0!important;right:0!important;width:100vw!important}}',
    // 与 applyQuickPhraseOrder 同一顺序：权限/规划组永远排在快捷短语之后。
    // JS 落位依赖挂载时序（找不到添加按钮时静默跳过），CSS 固定值兜底，结构在即生效。
    `[data-composer-card] [class*="_modes"]{order:${QUICK_PHRASE_PERMISSION_ORDER}}`,
  ].join('')
  document.head.appendChild(style)
}

type QuickPhraseSlotProps = {
  readonly useInput: SnapshotSelectorHook<InputState>
  readonly inputActions: InputActions
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly locale: CodingNsLocale
}

/** 在添加文件按钮右侧的输入工具区挂载插件自己的快捷会话入口。 */
export function registerQuickPhraseSlot(
  slots: SlotRegistry,
  settings: CodingNsSettingsStore<CodingNsSettings>,
  locale: CodingNsLocale,
): () => void {
  installQuickPhraseStyles()
  const t = locale.bind('codingns')
  return slots.inject('conversation.input.left', () => slots.register({
    name: 'conversation.input.left',
    id: 'codingns4dsh-quick-phrases',
    order: 0,
    label: t('workspace.quickPhrasesTrigger'),
    inject: () => ({ settings, locale }),
  }, QuickPhraseSlot))
}

function QuickPhraseSlot(props: QuickPhraseSlotProps): ReactElement | null {
  const t = useCodingNsTranslator(props.locale)
  const draft = props.useInput((value: InputState) => value.draft)
  const [phrases, setPhrases] = useState<readonly QuickPhrase[]>(() => readQuickPhrases(props.settings))
  const [open, setOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [newPhrase, setNewPhrase] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const quickPhraseRootRef = useRef<HTMLDivElement | null>(null)
  const [triggerSize, setTriggerSize] = useState({ width: QUICK_PHRASE_FALLBACK_SIZE, height: QUICK_PHRASE_FALLBACK_SIZE })
  const [iconSize, setIconSize] = useState(QUICK_PHRASE_FALLBACK_ICON_SIZE)
  const [triggerMargin, setTriggerMargin] = useState(QUICK_PHRASE_FALLBACK_MARGIN)
  const [messageAreaBounds, setMessageAreaBounds] = useState<{ readonly left: number; readonly width: number } | null>(null)

  useEffect(() => {
    const sync = (): void => setPhrases(readQuickPhrases(props.settings))
    sync()
    const workspaceSettings = props.settings.getSnapshot().value?.workspaceSessionEnhancement
    if (workspaceSettings?.quickPhrasesSeeded === false && workspaceSettings.quickPhrases.length === 0) {
      void props.settings.mutate([
        { op: 'set', path: ['workspaceSessionEnhancement', 'quickPhrases'], value: DEFAULT_QUICK_PHRASES.map((phrase) => ({ ...phrase })) },
        { op: 'set', path: ['workspaceSessionEnhancement', 'quickPhrasesSeeded'], value: true },
      ]).catch(() => undefined)
    }
    return props.settings.subscribe(sync)
  }, [props.settings])

  useEffect(() => {
    if (!open && !addOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (addOpen) setAddOpen(false)
      else setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [addOpen, open])

  useLayoutEffect(() => {
    const root = quickPhraseRootRef.current
    if (root === null || typeof document === 'undefined') return
    const addButton = findAddButton(root)
    if (addButton === null) return
    // 顺序、尺寸和间距都取自添加附件按钮所在的工具栏行，三者共用一个 flex 布局。
    const order = applyQuickPhraseOrder({ trigger: root, addButton })
    const positioningParent = findPositioningParent(root)
    const update = (): void => {
      const addRect = addButton.getBoundingClientRect()
      const nextSize = addRect.width > 0 && addRect.height > 0
        ? { width: addRect.width, height: addRect.height }
        : { width: QUICK_PHRASE_FALLBACK_SIZE, height: QUICK_PHRASE_FALLBACK_SIZE }
      setTriggerSize((current) => (current.width === nextSize.width && current.height === nextSize.height ? current : nextSize))
      const iconRect = addButton.querySelector<SVGElement>('svg')?.getBoundingClientRect()
      const nextIconSize = iconRect !== undefined && iconRect.width > 0 ? iconRect.width : QUICK_PHRASE_FALLBACK_ICON_SIZE
      setIconSize((current) => (current === nextIconSize ? current : nextIconSize))
      const nextMargin = readQuickPhraseMargin(order.container)
      setTriggerMargin((current) => (current === nextMargin ? current : nextMargin))
      const parentRect = positioningParent?.getBoundingClientRect()
      const nextBounds = { left: parentRect?.left ?? 0, width: parentRect?.width ?? window.innerWidth }
      setMessageAreaBounds((current) => (current !== null && current.left === nextBounds.left && current.width === nextBounds.width ? current : nextBounds))
    }
    update()
    const observer = typeof globalThis.ResizeObserver === 'function'
      ? new globalThis.ResizeObserver(update)
      : undefined
    observer?.observe(addButton)
    // 工具栏宽度变化会切换宿主的容器查询 gap，间距要跟着重算。
    if (order.container !== null) observer?.observe(order.container)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
      order.dispose()
    }
  }, [draft.length === 0])

  const persistPhrases = (next: readonly QuickPhrase[]): void => {
    setPhrases(next)
    setSaving(true)
    void props.settings.mutate([{
      op: 'set',
      path: ['workspaceSessionEnhancement', 'quickPhrases'],
      value: next,
    }, {
      op: 'set',
      path: ['workspaceSessionEnhancement', 'quickPhrasesSeeded'],
      value: true,
    }]).then((accepted) => setSaveError(!accepted)).catch(() => setSaveError(true)).finally(() => setSaving(false))
  }

  const addPhrase = (): void => {
    const text = newPhrase.trim()
    if (text === '' || saving) return
    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `quick-${Date.now()}-${Math.random().toString(36).slice(2)}`
    persistPhrases([...phrases, { id, text }])
    setNewPhrase('')
    setAddOpen(false)
  }

  const removePhrase = (id: string): void => {
    if (!saving) persistPhrases(phrases.filter((phrase) => phrase.id !== id))
  }

  const movePhrase = (fromId: string, toId: string): void => {
    if (fromId === toId || saving) return
    const from = phrases.findIndex((phrase) => phrase.id === fromId)
    const to = phrases.findIndex((phrase) => phrase.id === toId)
    if (from < 0 || to < 0) return
    const next = [...phrases]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    persistPhrases(next)
  }

  const enabled = props.settings.getSnapshot().value?.workspaceSessionEnhancement?.showQuickPhrases
    ?? true
  if (!enabled || draft.length > 0) {
    return null
  }

  const openAddDialog = (): void => {
    setNewPhrase('')
    setAddOpen(true)
  }

  return createElement('div', {
    ref: quickPhraseRootRef,
    // 负外边距把工具栏 gap 收窄到一半，两侧对称，不覆盖相邻控件。
    style: { ...quickPhraseRootStyle, marginLeft: triggerMargin, marginRight: triggerMargin },
  },
    createElement('button', {
      type: 'button',
      'aria-label': t('workspace.quickPhrasesTrigger'),
      title: t('workspace.quickPhrasesTrigger'),
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
      style: { ...quickPhraseTriggerStyle, width: triggerSize.width, height: triggerSize.height },
    }, createElement('svg', {
      width: iconSize,
      height: iconSize,
      // 收紧到图形自身边界，让 14px 的图标和添加附件按钮的图标视觉尺寸一致。
      viewBox: '4 4 16 20',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      'aria-hidden': true,
    },
      createElement('path', { d: 'M7 8h10' }),
      createElement('path', { d: 'M7 12h8' }),
      createElement('path', { d: 'M7 16h5' }),
      createElement('path', { d: 'M5 5h14v14H9l-4 4V5z' }),
    )),
    open && createElement('div', {
      className: 'codingns4dsh-quick-phrase-overlay',
      role: 'dialog',
      'aria-label': t('workspace.quickPhrasesDialogLabel'),
      'aria-modal': true,
      style: {
        ...quickPhraseOverlayStyle,
        ...(messageAreaBounds === null ? {} : { left: messageAreaBounds.left, right: 'auto', width: messageAreaBounds.width }),
      },
      onPointerDown: () => setOpen(false),
    }, createElement('div', {
      style: quickPhraseDialogStyle,
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    },
      createElement('div', { style: quickPhraseHeaderStyle },
        createElement('div', { style: { minWidth: 0 } },
          createElement('strong', { style: quickPhraseTitleStyle }, t('workspace.quickPhrasesTitle')),
          createElement('p', { style: quickPhraseHintStyle }, t('workspace.quickPhrasesHint')),
        ),
        createElement('div', { style: quickPhraseHeaderActionsStyle },
          createElement('button', {
            type: 'button',
            'aria-label': t('workspace.quickPhrasesAdd'),
            title: t('workspace.quickPhrasesAdd'),
            onClick: openAddDialog,
            style: quickPhraseIconButtonStyle,
          }, createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
            createElement('path', { d: 'M12 5v14' }),
            createElement('path', { d: 'M5 12h14' }),
          )),
          createElement('button', {
            type: 'button',
            'aria-label': t('workspace.quickPhrasesClose'),
            title: t('workspace.quickPhrasesClose'),
            onClick: () => setOpen(false),
            style: quickPhraseCloseStyle,
          }, '×'),
        ),
      ),
      saveError && createElement('div', { role: 'alert', style: quickPhraseSaveErrorStyle }, t('workspace.quickPhrasesSaveFailed')),
      phrases.length === 0
        ? createElement('div', { role: 'status', style: quickPhraseEmptyStyle }, t('workspace.quickPhrasesEmpty'))
        : createElement('div', { style: quickPhraseListStyle }, ...phrases.map((phrase) => createElement('div', {
          key: phrase.id,
          draggable: !saving,
          onDragStart: () => setDraggingId(phrase.id),
          onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
          onDrop: () => {
            if (draggingId !== null) movePhrase(draggingId, phrase.id)
            setDraggingId(null)
          },
          onDragEnd: () => setDraggingId(null),
          style: { ...quickPhraseItemStyle, ...(draggingId === phrase.id ? quickPhraseDraggingStyle : {}) },
        },
          createElement('button', {
            type: 'button',
            onClick: () => {
              props.inputActions.setDraft(phrase.text)
              setOpen(false)
            },
            style: quickPhraseTextButtonStyle,
          }, phrase.text),
          createElement('span', { role: 'img', 'aria-label': t('workspace.quickPhrasesDrag'), title: t('workspace.quickPhrasesDrag'), style: quickPhraseDragHandleStyle }, '⋮⋮'),
          createElement('button', {
            type: 'button',
            disabled: saving,
            'aria-label': t('workspace.quickPhrasesDelete'),
            title: t('workspace.quickPhrasesDelete'),
            onClick: () => removePhrase(phrase.id),
            style: quickPhraseDeleteStyle,
          }, '×'),
        )),
      ),
    )),
    addOpen && createElement('div', {
      className: 'codingns4dsh-quick-phrase-overlay',
      role: 'dialog',
      'aria-label': t('workspace.quickPhrasesAddDialogLabel'),
      'aria-modal': true,
      style: {
        ...quickPhraseEditorOverlayStyle,
        ...(messageAreaBounds === null ? {} : { left: messageAreaBounds.left, right: 'auto', width: messageAreaBounds.width }),
      },
      onPointerDown: (event: { stopPropagation: () => void }) => {
        event.stopPropagation()
        setAddOpen(false)
      },
    }, createElement('div', {
      style: quickPhraseEditorStyle,
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    },
      createElement('div', { style: quickPhraseEditorHeaderStyle },
        createElement('strong', { style: quickPhraseTitleStyle }, t('workspace.quickPhrasesAdd')),
        createElement('button', {
          type: 'button',
          'aria-label': t('workspace.quickPhrasesCancel'),
          title: t('workspace.quickPhrasesCancel'),
          onClick: () => setAddOpen(false),
          style: quickPhraseCloseStyle,
        }, '×'),
      ),
      createElement('input', {
        type: 'text',
        value: newPhrase,
        disabled: saving,
        autoFocus: true,
        placeholder: t('workspace.quickPhrasesPlaceholder'),
        onChange: (event: { currentTarget: { value: string } }) => setNewPhrase(event.currentTarget.value),
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            addPhrase()
          }
        },
        style: quickPhraseEditorInputStyle,
      }),
      createElement('div', { style: quickPhraseEditorActionsStyle },
        createElement('button', {
          type: 'button',
          onClick: () => setAddOpen(false),
          style: quickPhraseCancelButtonStyle,
        }, t('workspace.quickPhrasesCancel')),
        createElement('button', {
          type: 'button',
          disabled: saving || newPhrase.trim() === '',
          onClick: addPhrase,
          style: quickPhraseAddButtonStyle,
        }, t('workspace.quickPhrasesAdd')),
      ),
    )),
  )
}

function findAddButton(root: HTMLElement): HTMLButtonElement | null {
  let scope: HTMLElement | null = root.parentElement
  while (scope !== null) {
    const button = findAddButtonIn(scope)
    if (button !== null) return button
    scope = scope.parentElement
  }
  return findAddButtonIn(document)
}

/** 添加附件按钮：类名带 CSS Modules 本地名 `add` 且可见。哈希前缀随构建变化，不参与匹配。 */
function findAddButtonIn(scope: ParentNode): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>(ADD_BUTTON_CANDIDATE_SELECTOR))
    .find((button) => matchesDshCssModuleClass(button.className, 'add') && isVisibleElement(button)) ?? null
}

function findPositioningParent(root: HTMLElement): HTMLElement | null {
  let current = root.parentElement
  while (current !== null) {
    if (getComputedStyle(current).position !== 'static') return current
    current = current.parentElement
  }
  return null
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

function readQuickPhrases(settings: CodingNsSettingsStore<CodingNsSettings>): readonly QuickPhrase[] {
  const workspaceSettings = settings.getSnapshot().value?.workspaceSessionEnhancement
  const value = workspaceSettings?.quickPhrases
  if (!Array.isArray(value)) return DEFAULT_QUICK_PHRASES
  if (value.length === 0 && workspaceSettings?.quickPhrasesSeeded === false) return DEFAULT_QUICK_PHRASES
  return value.filter((phrase): phrase is QuickPhrase => (
    typeof phrase?.id === 'string' && phrase.id.length > 0
    && typeof phrase.text === 'string' && phrase.text.length > 0
  ))
}

const quickPhraseRootStyle = {
  // 与 DSH 工具栏同一个 flex 行：靠 order 排在权限组件之前，间距由宿主的 gap 决定。
  display: 'inline-flex',
  alignItems: 'center',
  order: QUICK_PHRASE_TRIGGER_ORDER,
  flex: '0 0 auto',
}
const quickPhraseTriggerStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: QUICK_PHRASE_FALLBACK_SIZE,
  height: QUICK_PHRASE_FALLBACK_SIZE,
  flex: '0 0 auto',
  padding: 0,
  border: 0,
  borderRadius: '50%',
  color: dshThemeColor.labelSecondary,
  background: 'transparent',
  cursor: 'pointer',
}
const quickPhraseOverlayStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 1400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  boxSizing: 'border-box' as const,
  background: 'transparent',
}
const quickPhraseDialogStyle = {
  ...dshPopupSurfaceStyle,
  width: 'min(100%, 720px)',
  maxHeight: 'min(720px, 90vh)',
  overflow: 'auto' as const,
  boxSizing: 'border-box' as const,
  padding: 24,
  borderRadius: 12,
}
const quickPhraseHeaderStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingBottom: 16, borderBottom: `1px solid ${dshThemeColor.border}` }
const quickPhraseHeaderActionsStyle = { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }
const quickPhraseTitleStyle = { display: 'block', color: dshThemeColor.labelPrimary, fontSize: 20, lineHeight: 1.3 }
const quickPhraseHintStyle = { margin: '6px 0 0', color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 }
const quickPhraseCloseStyle = { width: 32, height: 32, flex: '0 0 auto', border: 0, borderRadius: 16, color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: 24, lineHeight: 1, cursor: 'pointer' }
const quickPhraseIconButtonStyle = { width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 8, color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, cursor: 'pointer' }
const quickPhraseEditorOverlayStyle = { ...quickPhraseOverlayStyle, zIndex: 1410, background: 'transparent' }
const quickPhraseEditorStyle = { ...dshPopupSurfaceStyle, width: 'min(100%, 520px)', boxSizing: 'border-box' as const, padding: 24, borderRadius: 12 }
const quickPhraseEditorHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingBottom: 16, borderBottom: `1px solid ${dshThemeColor.border}` }
const quickPhraseEditorInputStyle = { width: '100%', minHeight: 92, marginTop: 16, boxSizing: 'border-box' as const, padding: '10px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.labelPrimary, background: dshThemeColor.inputBackground, fontSize: 14, lineHeight: 1.5, resize: 'vertical' as const }
const quickPhraseEditorActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 16 }
const quickPhraseCancelButtonStyle = { minHeight: 36, padding: '8px 14px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.labelPrimary, background: 'transparent', fontSize: 13, cursor: 'pointer' }
const quickPhraseAddButtonStyle = { flex: '0 0 auto', minHeight: 36, padding: '8px 14px', border: 0, borderRadius: 8, color: dshThemeColor.switchThumb, background: dshThemeColor.accent, fontSize: 13, cursor: 'pointer' }
const quickPhraseListStyle = { display: 'flex', flexDirection: 'column' as const, gap: 8, paddingTop: 16 }
const quickPhraseItemStyle = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 48, padding: '7px 8px 7px 14px', boxSizing: 'border-box' as const, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.labelPrimary, background: dshThemeColor.surfaceSubtle }
const quickPhraseDraggingStyle = { opacity: 0.55, borderColor: dshThemeColor.accent }
const quickPhraseTextButtonStyle = { flex: '1 1 auto', minWidth: 0, padding: 0, border: 0, color: dshThemeColor.labelPrimary, background: 'transparent', textAlign: 'left' as const, fontSize: 13, lineHeight: 1.5, cursor: 'pointer', overflowWrap: 'anywhere' as const }
const quickPhraseDragHandleStyle = { flex: '0 0 24px', color: dshThemeColor.labelTertiary, textAlign: 'center' as const, fontSize: 18, lineHeight: 1, cursor: 'grab', userSelect: 'none' as const }
const quickPhraseDeleteStyle = { width: 30, height: 30, flex: '0 0 30px', padding: 0, border: 0, borderRadius: 8, color: dshThemeColor.error, background: 'transparent', fontSize: 20, lineHeight: 1, cursor: 'pointer' }
const quickPhraseSaveErrorStyle = { color: dshThemeColor.error, fontSize: 12, lineHeight: 1.4 }
const quickPhraseEmptyStyle = { padding: '28px 0 10px', color: dshThemeColor.labelSecondary, textAlign: 'center' as const, fontSize: 13 }

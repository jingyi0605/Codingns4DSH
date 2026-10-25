import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactElement, RefObject } from 'react'
import type { MagpieContextPart, MagpieContextPartKind, MagpieContextSession } from '../shared/contracts/magpie-management.js'
import type { CodingNsRpcClient } from './features/types.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import { dshThemeColor } from './theme.js'
import { uiFontSize } from './font-scale.js'
import { getMagpieContextStore, useMagpieContext } from './magpie-context-store.js'
import type { SessionSnapshot } from './cli-slots.js'

const STYLE_ID = 'codingns4dsh-magpie-context-meter'
const COLORS: Readonly<Record<MagpieContextPartKind, string>> = {
  system: '#8b5cf6',
  tools: '#1ea7d9',
  memory: '#f1a31a',
  files: '#20b98b',
  results: '#e13d8d',
  chat: '#4f46d8',
}
const PART_LABEL_KEYS: Readonly<Record<MagpieContextPartKind, string>> = {
  system: 'magpie.context.system',
  tools: 'magpie.context.tools',
  memory: 'magpie.context.memory',
  files: 'magpie.context.files',
  results: 'magpie.context.results',
  chat: 'magpie.context.chat',
}
const PART_ORDER: readonly MagpieContextPartKind[] = ['system', 'tools', 'memory', 'files', 'results', 'chat']
const NATIVE_PARTS = [
  { key: 'systemTokens', label: 'magpie.context.system', color: 'var(--dsw-static-neutral-bluish-400, #aeb3bc)' },
  { key: 'toolsTokens', label: 'magpie.context.nativeTools', color: '#a78bfa' },
  { key: 'messageTokens', label: 'magpie.context.nativeMessages', color: 'var(--dsw-static-blue-450, #4b8df8)' },
] as const

interface NativeContextPressure {
  readonly projectedTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

interface NativeContextBreakdown {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
}

const FALLBACK_LOCALE: CodingNsLocale = {
  bind: () => resolveCodingNsTranslator(),
  getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
}

export interface MagpieContextMeterProps {
  readonly rpc?: CodingNsRpcClient
  readonly sessionId?: string
  readonly locale?: CodingNsLocale
  readonly useSession?: <Selected>(selector: (value: SessionSnapshot) => Selected) => Selected
  readonly useProjection?: (key: string) => unknown
}

interface Placement {
  readonly left: number
  readonly bottom: number
}

/**
 * Enhance DSH's native ContextMeter without adding another visible trigger.
 * The native button receives Magpie's pressure through the composer projection;
 * this zero-layout entry only redirects its dialog to the Magpie inspector.
 */
export function MagpieContextMeter({ rpc, sessionId, locale, useSession, useProjection }: MagpieContextMeterProps): ReactElement | null {
  const state = useMagpieContext(rpc, sessionId)
  const store = rpc === undefined || sessionId === undefined ? undefined : getMagpieContextStore(rpc, sessionId)
  const running = useSession?.(value => value.running) === true
  const revision = useSession?.(value => JSON.stringify([value.modelSelection, value.running]))
  // Dock standard props expose the original projections, before the composer overrides Magpie pressure.
  const nativePressure = useProjection?.('contextPressure') as NativeContextPressure | undefined
  const nativeBreakdown = useProjection?.('contextBreakdown') as NativeContextBreakdown | undefined
  const [open, setOpen] = useState(false)
  const [activeKind, setActiveKind] = useState<MagpieContextPartKind | 'all'>('all')
  const [placement, setPlacement] = useState<Placement>({ left: 12, bottom: 52 })
  const rootRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  const t = useCodingNsTranslator(locale ?? FALLBACK_LOCALE)

  useEffect(() => { installStyles() }, [])
  useEffect(() => {
    if (revision !== undefined) void store?.refresh()
  }, [revision, store])
  useEffect(() => {
    openRef.current = open
    store?.setPolling(open || running || state.status === 'ready')
    return () => store?.setPolling(false)
  }, [open, running, state.status, store])
  useEffect(() => {
    if (state.status !== 'ready' && open) setOpen(false)
  }, [open, state.status])

  const updatePlacement = useCallback((): void => {
    if (typeof window === 'undefined') return
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const panelWidth = Math.min(980, Math.max(280, window.innerWidth - 24))
    const left = Math.max(12, Math.min(rect.left - Math.max(0, (panelWidth - rect.width) / 2), window.innerWidth - panelWidth - 12))
    setPlacement({ left, bottom: Math.max(12, window.innerHeight - rect.top + 8) })
  }, [])

  useEffect(() => {
    if (state.status !== 'ready' || typeof document === 'undefined') return
    const root = rootRef.current
    // SlotOutlet adds a display:contents wrapper; the native meter is its sibling.
    const dock = root?.closest<HTMLElement>('[data-composer-dock]')
    if (dock === null || dock === undefined) return
    let attached: HTMLButtonElement | null = null
    let nativeExpanded: string | null = null
    const onClick = (event: Event): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      updatePlacement()
      setOpen(value => !value)
    }
    const detach = (): void => {
      if (attached === null) return
      attached.removeEventListener('click', onClick, true)
      if (nativeExpanded === null) attached.removeAttribute('aria-expanded')
      else attached.setAttribute('aria-expanded', nativeExpanded)
      if (anchorRef.current === attached) anchorRef.current = null
    }
    const bind = (): void => {
      const next = findNativeContextTrigger(dock)
      if (next === attached) return
      detach()
      attached = next
      anchorRef.current = next
      if (next !== null) {
        nativeExpanded = next.getAttribute('aria-expanded')
        next.setAttribute('aria-expanded', String(openRef.current))
        next.addEventListener('click', onClick, true)
      }
      if (openRef.current) updatePlacement()
    }
    bind()
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(bind)
    observer?.observe(dock, { childList: true, subtree: true })
    return () => {
      observer?.disconnect()
      detach()
    }
  }, [state.status, updatePlacement])

  useEffect(() => {
    if (!open) return
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])
  useDismissOnOutsidePointer(anchorRef, open, () => setOpen(false), { portal: panelRef })
  useEffect(() => {
    const trigger = anchorRef.current
    if (trigger === null) return
    trigger.setAttribute('aria-expanded', String(open))
  }, [open])

  if (state.status !== 'ready') return createElement('span', { ref: rootRef, 'data-codingns-magpie-context-enhancer': true, style: hiddenEnhancerStyle })
  const value = state.value
  const panel = open && typeof document !== 'undefined'
    ? createPortal(createContextPanel(value, t, activeKind, setActiveKind, () => setOpen(false), placement, panelRef,
      createNativeContextSummary(nativePressure, nativeBreakdown, t)), document.body)
    : null
  return createElement('span', { ref: rootRef, 'data-codingns-magpie-context-enhancer': true, style: hiddenEnhancerStyle }, panel)
}

const hiddenEnhancerStyle: CSSProperties = { display: 'none' }

function findNativeContextTrigger(dock: HTMLElement): HTMLButtonElement | null {
  for (const button of dock.querySelectorAll<HTMLButtonElement>('button.JObwrW_trigger')) {
    if (button.closest('[data-composer-dock]') === dock
      && button.closest('[data-codingns-magpie-context-enhancer]') === null
      && button.closest('.JObwrW_root') !== null) return button
  }
  return null
}

function createNativeContextSummary(
  pressure: NativeContextPressure | undefined,
  breakdown: NativeContextBreakdown | undefined,
  t: CodingNsTranslator,
): ReactElement | null {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const capacity = pressure?.contextWindow
  if (!isTokenCount(used) || !isTokenCount(capacity) || capacity === 0) return null
  const percent = Math.min(100, Math.round(used / capacity * 100))
  const parts = breakdown !== undefined && NATIVE_PARTS.every(part => isTokenCount(breakdown?.[part.key]))
    ? NATIVE_PARTS.map(part => ({ ...part, tokens: breakdown[part.key] }))
    : []
  const total = parts.reduce((sum, part) => sum + part.tokens, 0)
  return createElement('section', {
    className: 'codingns4dsh-magpie-context-native',
    'aria-label': t('magpie.context.native'),
  },
    createElement('strong', { className: 'codingns4dsh-magpie-context-heading-label' }, t('magpie.context.native')),
    createElement('div', { className: 'codingns4dsh-magpie-context-native-usage' },
      createElement('span', undefined, t('magpie.context.usedPercent', { percent })),
      createElement('strong', undefined, `~${formatTokens(used)} / ${formatTokens(capacity)}`)),
    createElement('div', {
      className: 'codingns4dsh-magpie-context-native-bar',
      role: 'meter',
      'aria-label': t('magpie.context.used'),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': percent,
    }, total > 0
      ? parts.map(part => createElement('span', { key: part.key, style: { width: `${percent * part.tokens / total}%`, background: part.color } }))
      : createElement('span', { style: { width: `${percent}%`, background: dshThemeColor.labelTertiary } })),
    parts.length > 0 && createElement('div', { className: 'codingns4dsh-magpie-context-caption' }, t('magpie.context.nativeComposition')),
    parts.length > 0 && createElement('dl', { className: 'codingns4dsh-magpie-context-native-parts' },
      parts.map(part => createElement('div', { key: part.key },
        createElement('dt', undefined,
          createElement('i', { 'aria-hidden': true, style: { background: part.color } }),
          t(part.label)),
        createElement('dd', undefined,
          createElement('span', undefined, `~${formatTokens(part.tokens)}`),
          createElement('span', { className: 'codingns4dsh-magpie-context-caption' },
            `${total > 0 ? trimDecimal(part.tokens / total * 100) : '0'}%`))))),
  )
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function createContextPanel(
  value: MagpieContextSession,
  t: CodingNsTranslator,
  activeKind: MagpieContextPartKind | 'all',
  setActiveKind: (kind: MagpieContextPartKind | 'all') => void,
  close: () => void,
  placement: Placement,
  panelRef: RefObject<HTMLDivElement | null>,
  nativeSummary: ReactElement | null,
): ReactElement {
  const used = formatTokens(value.usedTokens)
  const windowSize = formatTokens(value.contextWindow)
  const cache = `${Math.round(value.cacheRate * 100)}%`
  const parts = PART_ORDER.map(kind => value.parts.find(part => part.kind === kind) ?? emptyPart(kind))
  const total = Math.max(1, parts.reduce((sum, part) => sum + part.tokens, 0))
  const visibleParts = activeKind === 'all' ? parts : parts.filter(part => part.kind === activeKind)
  const contentItems = visibleParts.flatMap(part => part.items.map(item => ({ ...item, kind: part.kind })))
    .sort((left, right) => right.tokens - left.tokens)
  const rounds = value.points.slice(-12).reverse()
  return createElement('div', {
    ref: panelRef,
    className: 'codingns4dsh-magpie-context-panel',
    role: 'dialog',
    'aria-label': t('magpie.context.window'),
    style: { left: placement.left, bottom: placement.bottom },
  },
    nativeSummary,
    createElement('div', { className: 'codingns4dsh-magpie-context-heading' },
      createElement('div', undefined,
        createElement('div', { className: 'codingns4dsh-magpie-context-heading-label' }, t('magpie.context.used')),
        createElement('strong', { className: 'codingns4dsh-magpie-context-heading-value' }, used),
        createElement('span', { className: 'codingns4dsh-magpie-context-heading-unit' }, ' token'),
        createElement('div', { className: 'codingns4dsh-magpie-context-caption' }, t('magpie.context.modelWindow', { value: windowSize }))),
      createElement('div', { className: 'codingns4dsh-magpie-context-cache' },
        createElement('div', { className: 'codingns4dsh-magpie-context-heading-label' }, t('magpie.context.cache')),
        createElement('strong', { className: 'codingns4dsh-magpie-context-cache-value' }, cache),
        createElement('div', { className: 'codingns4dsh-magpie-context-caption' }, t('magpie.context.hit')),
        createElement('div', { className: 'codingns4dsh-magpie-context-cache-track' }, createElement('span', { style: { width: `${Math.round(value.cacheRate * 100)}%` } }))),
      createElement('div', { className: 'codingns4dsh-magpie-context-model' },
        createElement('span', undefined, value.model),
        createElement('button', { type: 'button', onClick: close, 'aria-label': t('magpie.context.close') }, '×'))),
    createElement('div', { className: 'codingns4dsh-magpie-context-treemap', 'aria-label': t('magpie.context.composition') },
      parts.map(part => createElement('div', {
        key: part.kind,
        className: `codingns4dsh-magpie-context-block codingns4dsh-magpie-context-block-${part.kind}`,
        style: {
          '--codingns-magpie-part-color': COLORS[part.kind],
          '--codingns-magpie-part-size': `${Math.max(4, part.tokens / total * 100)}%`,
          flex: `${Math.max(0.04, part.tokens / total)} 1 0`,
        } as CSSProperties,
      }, createElement('strong', undefined, labelFor(part.kind, t)), createElement('span', undefined, formatTokens(part.tokens))))),
    createElement('div', { className: 'codingns4dsh-magpie-context-legend' },
      parts.map(part => createElement('button', {
        key: part.kind,
        type: 'button',
        className: activeKind === part.kind ? 'is-active' : '',
        onClick: () => setActiveKind(activeKind === part.kind ? 'all' : part.kind),
      }, createElement('i', { style: { background: COLORS[part.kind] } }), labelFor(part.kind, t), formatTokens(part.tokens)))),
    createElement('div', { className: 'codingns4dsh-magpie-context-content-heading' },
      createElement('strong', undefined, t('magpie.context.content')),
      createElement('span', undefined, t('magpie.context.allCount', { count: contentItems.length }))),
    createElement('div', { className: 'codingns4dsh-magpie-context-tabs' },
      createElement('button', { type: 'button', className: activeKind === 'all' ? 'is-active' : '', onClick: () => setActiveKind('all') }, t('magpie.context.all')),
      parts.map(part => createElement('button', { key: part.kind, type: 'button', className: activeKind === part.kind ? 'is-active' : '', onClick: () => setActiveKind(part.kind) }, labelFor(part.kind, t)))),
    createElement('div', { className: 'codingns4dsh-magpie-context-list' },
      contentItems.length === 0
        ? createElement('div', { className: 'codingns4dsh-magpie-context-empty' }, t('magpie.context.empty'))
        : contentItems.slice(0, 61).map((item, index) => createElement('div', { key: `${item.kind}-${item.name}-${index}`, className: 'codingns4dsh-magpie-context-row' },
          createElement('span', { className: 'codingns4dsh-magpie-context-row-name' }, displayItemName(item.name, item.kind, item.count, t)),
          createElement('span', { className: 'codingns4dsh-magpie-context-row-tag' }, item.tag ?? labelFor(item.kind, t)),
          createElement('span', { className: 'codingns4dsh-magpie-context-row-bar' }, createElement('i', { style: { width: `${Math.min(100, Math.max(2, item.tokens / Math.max(1, contentItems[0]!.tokens) * 100))}%`, background: COLORS[item.kind] } })),
          createElement('span', { className: 'codingns4dsh-magpie-context-row-value' }, formatTokens(item.tokens))))),
    createElement('div', { className: 'codingns4dsh-magpie-context-session' },
      createElement('div', { className: 'codingns4dsh-magpie-context-breadcrumb' }, `${value.agent} › ${truncate(value.key)} › #${value.latestId ?? '—'}`),
      createElement('span', undefined, `${t('magpie.context.rounds', { count: value.turns })} · ${t('magpie.context.requests', { count: value.requests })}`)),
    rounds.length > 0 && createElement('div', { className: 'codingns4dsh-magpie-context-rounds' }, rounds.map((point, index) => createElement('div', { key: point.id, className: 'codingns4dsh-magpie-context-round' },
      createElement('span', undefined, t('magpie.context.request', { count: value.points.length - index })),
      createElement('i', undefined, createElement('b', { style: { width: `${Math.min(100, point.tokens / Math.max(1, value.contextWindow) * 100)}%` } })),
      createElement('span', undefined, formatTokens(point.tokens))))),
  )
}

function installStyles(): null {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return null
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.codingns4dsh-magpie-context-panel{position:fixed;z-index:10000;width:min(980px,calc(100vw - 24px));max-height:min(82vh,780px);overflow:auto;box-sizing:border-box;padding:18px 20px 12px;color:${dshThemeColor.labelPrimary};background:${dshThemeColor.menuBackground};border:1px solid ${dshThemeColor.menuBorder};border-radius:14px;box-shadow:${dshThemeColor.prominentShadow};font-size:${uiFontSize(12)};line-height:1.35}
.codingns4dsh-magpie-context-native{border-bottom:1px solid ${dshThemeColor.fieldBorder};padding-bottom:14px;margin-bottom:16px}.codingns4dsh-magpie-context-native-usage{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:7px;color:${dshThemeColor.labelSecondary};font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-native-usage strong{margin-left:auto;color:${dshThemeColor.labelPrimary};font-weight:500}.codingns4dsh-magpie-context-native-bar{display:flex;height:4px;overflow:hidden;margin:10px 0 12px;border-radius:99px;background:${dshThemeColor.surfaceSubtle}}.codingns4dsh-magpie-context-native-bar span{flex:none;height:100%;border-radius:1px}.codingns4dsh-magpie-context-native-parts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px 24px;margin:8px 0 0}.codingns4dsh-magpie-context-native-parts>div{display:flex;justify-content:space-between;align-items:center;gap:8px;min-width:0}.codingns4dsh-magpie-context-native-parts dt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${dshThemeColor.labelSecondary}}.codingns4dsh-magpie-context-native-parts dt i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.codingns4dsh-magpie-context-native-parts dd{display:flex;gap:8px;margin:0;white-space:nowrap;font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-native-parts dd .codingns4dsh-magpie-context-caption{margin:0}
@media (max-width:640px){.codingns4dsh-magpie-context-native-parts{grid-template-columns:minmax(0,1fr)}}
.codingns4dsh-magpie-context-heading{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1fr) minmax(160px,1fr);gap:18px;align-items:start;margin-bottom:14px}.codingns4dsh-magpie-context-heading-label{color:${dshThemeColor.labelTertiary};font-size:${uiFontSize(12)};font-weight:600}.codingns4dsh-magpie-context-heading-value{font-size:${uiFontSize(28)};line-height:1;font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-heading-unit{color:${dshThemeColor.labelSecondary};margin-left:4px}.codingns4dsh-magpie-context-caption{color:${dshThemeColor.labelTertiary};margin-top:4px}.codingns4dsh-magpie-context-cache-value{display:block;color:#6bbd99;font-size:${uiFontSize(28)};line-height:1;font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-cache-track{height:6px;margin-top:8px;border-radius:99px;background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.12));overflow:hidden}.codingns4dsh-magpie-context-cache-track span{display:block;height:100%;background:#8bcfae;border-radius:inherit}.codingns4dsh-magpie-context-model{display:flex;justify-content:space-between;gap:8px;color:${dshThemeColor.labelSecondary};font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-model button{border:0;background:transparent;color:${dshThemeColor.labelTertiary};font-size:20px;line-height:18px;cursor:pointer}
.codingns4dsh-magpie-context-treemap{display:flex;min-height:168px;gap:4px;margin:8px 0 10px}.codingns4dsh-magpie-context-block{min-width:0;display:flex;flex-direction:column;justify-content:flex-start;padding:9px 10px;border:1px solid color-mix(in srgb,var(--codingns-magpie-part-color) 25%,transparent);border-radius:8px;background:color-mix(in srgb,var(--codingns-magpie-part-color) 9%,transparent);color:var(--codingns-magpie-part-color);overflow:hidden}.codingns4dsh-magpie-context-block strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${uiFontSize(12)}}.codingns4dsh-magpie-context-block span{font-size:${uiFontSize(11)};color:${dshThemeColor.labelTertiary};font-variant-numeric:tabular-nums}
.codingns4dsh-magpie-context-legend{display:flex;flex-wrap:wrap;gap:5px 13px;border-bottom:1px solid ${dshThemeColor.fieldBorder};padding-bottom:10px}.codingns4dsh-magpie-context-legend button,.codingns4dsh-magpie-context-tabs button{border:0;background:transparent;color:${dshThemeColor.labelSecondary};cursor:pointer;padding:3px 0;font-size:${uiFontSize(11)};font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-legend button.is-active,.codingns4dsh-magpie-context-tabs button.is-active{color:${dshThemeColor.labelPrimary};font-weight:700}.codingns4dsh-magpie-context-legend i{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:2px}
.codingns4dsh-magpie-context-content-heading{display:flex;justify-content:space-between;align-items:center;margin-top:13px;font-size:${uiFontSize(13)}}.codingns4dsh-magpie-context-content-heading span{color:${dshThemeColor.labelTertiary};font-size:${uiFontSize(11)}}.codingns4dsh-magpie-context-tabs{display:flex;gap:13px;overflow:auto;margin:8px 0 2px;border-bottom:1px solid ${dshThemeColor.fieldBorder}}.codingns4dsh-magpie-context-list{display:flex;flex-direction:column;min-height:60px}.codingns4dsh-magpie-context-row{display:grid;grid-template-columns:minmax(90px,1.1fr) minmax(70px,.7fr) minmax(100px,1fr) 52px;gap:9px;align-items:center;min-height:27px;border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent)}.codingns4dsh-magpie-context-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.codingns4dsh-magpie-context-row-tag{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${dshThemeColor.labelTertiary};font-size:${uiFontSize(10)}}.codingns4dsh-magpie-context-row-bar{height:5px;border-radius:99px;background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.12));overflow:hidden}.codingns4dsh-magpie-context-row-bar i{display:block;height:100%;border-radius:inherit}.codingns4dsh-magpie-context-row-value{text-align:right;color:${dshThemeColor.labelSecondary};font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-empty{padding:22px;text-align:center;color:${dshThemeColor.labelTertiary}}
.codingns4dsh-magpie-context-session{display:flex;justify-content:space-between;gap:10px;margin-top:13px;color:${dshThemeColor.labelTertiary};font-size:${uiFontSize(11)};font-variant-numeric:tabular-nums}.codingns4dsh-magpie-context-breadcrumb{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codingns4dsh-magpie-context-rounds{display:flex;flex-direction:column;gap:3px;margin-top:7px}.codingns4dsh-magpie-context-round{display:grid;grid-template-columns:75px minmax(80px,1fr) 50px;gap:8px;align-items:center;color:${dshThemeColor.labelTertiary};font-size:${uiFontSize(10)}}.codingns4dsh-magpie-context-round i{height:4px;border-radius:99px;background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.12));overflow:hidden}.codingns4dsh-magpie-context-round b{display:block;height:100%;border-radius:inherit;background:#4f46d8}.codingns4dsh-magpie-context-round>span:last-child{text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:640px){.codingns4dsh-magpie-context-panel{padding:13px 12px 10px}.codingns4dsh-magpie-context-heading{grid-template-columns:1fr 1fr;gap:10px}.codingns4dsh-magpie-context-model{grid-column:1 / -1}.codingns4dsh-magpie-context-treemap{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,54px)}.codingns4dsh-magpie-context-block{flex:initial!important}.codingns4dsh-magpie-context-row{grid-template-columns:minmax(90px,1fr) minmax(90px,1fr) 52px}.codingns4dsh-magpie-context-row-tag{display:none}.codingns4dsh-magpie-context-session{display:block}.codingns4dsh-magpie-context-session>span{display:block;margin-top:3px}}
@media (prefers-reduced-motion:reduce){.codingns4dsh-magpie-context-panel{transition:none}}
`
  document.head.appendChild(style)
  return null
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${trimDecimal(value / 1_000)}K`
  return `${trimDecimal(value / 1_000_000)}M`
}

function trimDecimal(value: number): string {
  return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10).toString()
}

function labelFor(kind: MagpieContextPartKind, t: CodingNsTranslator): string {
  return t(PART_LABEL_KEYS[kind])
}

function emptyPart(kind: MagpieContextPartKind): MagpieContextPart {
  return { kind, tokens: 0, items: [] }
}

function displayItemName(name: string, kind: MagpieContextPartKind, count: number | undefined, t: CodingNsTranslator): string {
  if (kind === 'chat' && name === 'earlier') return t('magpie.context.earlierRounds', { count: count ?? 0 })
  if (kind === 'chat' && /^\d+$/u.test(name)) return t('magpie.context.round', { count: name })
  return name
}

function truncate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}…` : value
}

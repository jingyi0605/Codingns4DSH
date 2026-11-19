import { createElement, Fragment, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { AntigravityContextDetails } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { uiFontSize } from './font-scale.js'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import { dshThemeColor } from './theme.js'

interface AntigravityContextMeterProps {
  readonly sessionId?: string
  readonly native?: boolean
  readonly pressureTokens?: number
  readonly contextWindow?: number
  readonly locale: CodingNsLocale
  readonly rpc?: CodingNsRpcClient
}

export function AntigravityContextMeter(props: AntigravityContextMeterProps): ReactElement {
  return props.native ? createElement(NativeCompactionThreshold, props) : createElement(FallbackContextMeter, props)
}

function NativeCompactionThreshold(props: AntigravityContextMeterProps): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null)
  const [panel, setPanel] = useState<Element | null>(null)
  useEffect(() => {
    const dock = anchor.current?.closest('[data-composer-dock]')
    if (dock === undefined || dock === null) return
    const findPanel = () => {
      const nativeRoot = dock.querySelector<HTMLElement>('.JObwrW_root')
      const anchorName = nativeRoot?.style.getPropertyValue('anchor-name')
      const next = anchorName ? Array.from(document.body.children).find(child => (
        child.getAttribute('role') === 'dialog'
        && (child as HTMLElement).style?.getPropertyValue('position-anchor') === anchorName
      )) : undefined
      setPanel(next ?? null)
    }
    findPanel()
    const observer = new MutationObserver(findPanel)
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, [])
  return createElement('span', { ref: anchor, hidden: true, 'data-codingns-antigravity-compaction-anchor': '' },
    panel === null ? null : createPortal(createElement(ContextSummary, props), panel))
}

function ContextSummary(props: AntigravityContextMeterProps): ReactElement {
  const { contextWindow, pressureTokens, locale, native } = props
  const t = useCodingNsTranslator(locale)
  return createElement('div', { 'data-codingns-antigravity-summary': '', style: summaryStyle },
    native ? createElement('style', undefined, nativeSummaryCss) : null,
    contextWindow === undefined
      ? createElement('div', undefined,
          createElement('div', undefined, pressureTokens === undefined
            ? t('cli.antigravityContextPending')
            : t('cli.antigravityContextUsed', { count: pressureTokens.toLocaleString() })),
          createElement('div', undefined, t('cli.antigravityContextUnknownCapacity')))
      : createElement(ProgressRow, {
          label: t('cli.antigravityContextUsage'),
          used: pressureTokens, limit: contextWindow, color: dshThemeColor.accent,
        }),
    createElement(ContextDetails, props))
}

function ContextDetails({ sessionId, rpc, pressureTokens, locale }: AntigravityContextMeterProps): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const [details, setDetails] = useState<AntigravityContextDetails | null | undefined>(undefined)
  useEffect(() => {
    if (rpc === undefined || sessionId === undefined) return
    const controller = new AbortController()
    const read = async () => {
      try {
        const result = await rpc.call('codingns', 'cli/session/antigravity-context', { sessionId }, controller.signal)
        if (controller.signal.aborted) return
        setDetails(result.ok && result.value !== null && typeof result.value === 'object' ? result.value as AntigravityContextDetails : null)
      } catch {
        if (!controller.signal.aborted) setDetails(null)
      }
    }
    void read()
    return () => controller.abort()
  }, [rpc, sessionId, pressureTokens])
  if (details === undefined) return null
  const threshold = details?.compactionThreshold
  const rows = breakdownParts.flatMap(({ key, label, color }) => {
    const tokens = details?.breakdown?.[key]
    if (tokens === undefined) return []
    return [createElement('div', { key, style: progressLabelStyle },
      createElement('dt', { style: breakdownLabelStyle },
        createElement('span', { 'aria-hidden': true, style: { ...breakdownSwatchStyle, background: color } }), t(label)),
      createElement('dd', { style: breakdownValueStyle, title: tokens.toLocaleString() }, `~${compactTokens.format(tokens)}`))]
  })
  return createElement(Fragment, undefined,
    threshold == null
      ? createElement('div', undefined, t('cli.antigravityCompactionUnknown'))
      : createElement('div', { 'data-codingns-antigravity-compaction': '' },
          createElement(ProgressRow, {
            label: t('cli.antigravityCompactionThreshold'),
            used: pressureTokens, limit: threshold, color: dshThemeColor.warning,
          })),
    createElement('div', { 'data-codingns-antigravity-breakdown': '' },
      rows.length === 0 ? createElement('div', { style: breakdownCaptionStyle }, t('cli.antigravityBreakdownUnavailable'))
        : createElement(Fragment, undefined,
            createElement('div', { style: breakdownCaptionStyle }, t('cli.antigravityBreakdownEstimate')),
            createElement('dl', { style: breakdownListStyle }, rows))))
}

function ProgressRow({ label, used, limit, color }: {
  readonly label: string
  readonly used: number | undefined
  readonly limit: number
  readonly color: string
}): ReactElement {
  const value = used === undefined ? undefined : Math.min(used, limit)
  const percent = value === undefined ? undefined : value / limit * 100
  const figures = used === undefined ? compactTokens.format(limit) : `~${compactTokens.format(used)} / ${compactTokens.format(limit)}`
  const exactFigures = used === undefined ? limit.toLocaleString() : `${used.toLocaleString()} / ${limit.toLocaleString()}`
  return createElement('div', undefined,
    createElement('div', { style: progressLabelStyle },
      createElement('span', undefined, label,
        percent === undefined ? null : createElement('strong', { style: progressPercentStyle }, ` ${Math.round(percent)}%`)),
      createElement('strong', { style: progressFiguresStyle, title: exactFigures }, figures)),
    percent === undefined ? null : createElement('div', {
      role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': limit, 'aria-valuenow': value,
      style: progressTrackStyle,
    }, createElement('div', { style: {
      width: `${percent}%`, minWidth: percent > 0 ? 2 : 0, height: '100%', borderRadius: 999, background: color,
    } })))
}

function FallbackContextMeter(props: AntigravityContextMeterProps): ReactElement {
  const t = useCodingNsTranslator(props.locale)
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ right: number; bottom: number } | null>(null)
  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPosition(previous => previous === null ? {
      right: Math.min(Math.max(12, window.innerWidth - rect.right), Math.max(12, window.innerWidth - panelWidth - 12)),
      bottom: window.innerHeight - rect.top + 8,
    } : null)
  }
  useDismissOnOutsidePointer(trigger, position !== null, () => setPosition(null), { portal: panel })
  const title = t('cli.antigravityContextTitle')
  return createElement('span', undefined,
    createElement('button', {
      type: 'button', ref: trigger, onClick: toggle, 'aria-controls': panelId,
      'aria-expanded': position !== null, style: buttonStyle,
    }, title),
    position !== null && createPortal(createElement('div', {
      id: panelId, ref: panel, role: 'region', 'aria-label': title, style: { ...panelStyle, ...position },
    }, createElement(ContextSummary, props)), document.body),
  )
}

const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const breakdownParts = [
  { key: 'systemTokens', label: 'magpie.context.system', color: 'var(--dsw-static-neutral-bluish-400, #aeb3bc)' },
  { key: 'toolsTokens', label: 'magpie.context.nativeTools', color: '#a78bfa' },
  { key: 'messageTokens', label: 'magpie.context.nativeMessages', color: 'var(--dsw-static-blue-450, #4b8df8)' },
] as const
const panelWidth = 324
const responsivePanelWidth = `min(${panelWidth}px, calc(100vw - 24px))`
const nativeSummaryCss = `
  .JObwrW_panel:has(> [data-codingns-antigravity-summary]) { width: ${responsivePanelWidth}; }
  .JObwrW_panel:has(> [data-codingns-antigravity-summary]) > :is(.JObwrW_header, .JObwrW_bar) { display: none; }
`

const buttonStyle: CSSProperties = {
  fontSize: uiFontSize(12), color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle,
  padding: '3px 6px', border: 0, borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
}

const panelStyle: CSSProperties = {
  position: 'fixed', zIndex: 1000, boxSizing: 'border-box', width: responsivePanelWidth,
  padding: '10px 12px', border: `1px solid ${dshThemeColor.menuBorder}`, borderRadius: 10,
  background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow,
}

const summaryStyle: CSSProperties = {
  display: 'grid', gap: 12, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13), lineHeight: 1.4,
}

const progressLabelStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8,
}

const progressPercentStyle: CSSProperties = { fontWeight: 600, color: dshThemeColor.labelPrimary }

const progressFiguresStyle: CSSProperties = {
  ...progressPercentStyle, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

const progressTrackStyle: CSSProperties = {
  height: 5, borderRadius: 999, background: dshThemeColor.hoverBackground, overflow: 'hidden', marginTop: 8,
}

const breakdownCaptionStyle: CSSProperties = { fontSize: uiFontSize(12) }
const breakdownListStyle: CSSProperties = { display: 'grid', gap: 6, margin: '6px 0 0' }
const breakdownLabelStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const breakdownSwatchStyle: CSSProperties = { width: 9, height: 9, borderRadius: 2, flexShrink: 0 }
const breakdownValueStyle: CSSProperties = { ...progressFiguresStyle, fontWeight: 400, margin: 0 }

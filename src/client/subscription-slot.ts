import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { CliSubscriptionUsage, CliSubscriptionWindow, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../shared/contracts/subscription.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    sessionId: string
  }
}

interface SubscriptionSlotProps {
  readonly rpc: CodingNsRpcClient
  readonly sessionId?: string
}

/** 在 DSH 原生步骤统计左侧显示当前 Agent 的订阅余量。 */
export function registerSubscriptionSlot(slots: SlotRegistry, rpc: CodingNsRpcClient): () => void {
  return slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-codingns-subscription',
    order: -20,
    label: 'Agent 订阅余量',
    inject: (sessionId: string) => ({ rpc, sessionId }),
  }, CommandCodeSubscriptionSlot))
}

function CommandCodeSubscriptionSlot(props: SubscriptionSlotProps): ReactElement | null {
  const [usage, setUsage] = useState<CliSubscriptionUsage | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const [eligible, setEligible] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sessionId = props.sessionId?.trim()
    if (!sessionId) {
      setEligible(false)
      setUsage(null)
      setAdapterId(null)
      setOpen(false)
      return
    }
    let active = true
    setEligible(false)
    setUsage(null)
    setAdapterId(null)
    setOpen(false)
    const refresh = async (): Promise<void> => {
      setLoading(true)
      try {
        const selection = await callCliRpc<{ readonly adapterId?: string }>(props.rpc, 'session/get', { sessionId })
        const adapterId = selection.adapterId
        if (!active || !isSubscriptionAdapter(adapterId)) {
          if (active) {
            setEligible(false)
            setUsage(null)
            setAdapterId(null)
          }
          return
        }
        if (active) {
          setEligible(true)
          setAdapterId(adapterId)
        }
        const next = await callCliRpc<CliSubscriptionUsage | null>(props.rpc, 'subscription', { adapterId })
        if (active) setUsage(next)
      } catch {
        if (active) {
          setEligible(false)
          setUsage(null)
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void refresh()
    const timer = globalThis.setInterval(() => { void refresh() }, 5 * 60_000)
    return () => {
      active = false
      globalThis.clearInterval(timer)
    }
  }, [props.rpc, props.sessionId])

  useEffect(() => {
    if (!eligible || usage === null) return
    const timer = globalThis.setInterval(() => setClock(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [eligible, usage])

  useEffect(() => {
    if (!open) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !rootRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  // 未拿到真实订阅数据时不占用底部栏空间；加载状态不能伪装成订阅存在。
  if (!eligible || usage === null || (usage.sub2api === undefined && resolveDisplayWindow(usage) === null)) return null
  const sub2api = usage.sub2api
  const displayWindow = sub2api === undefined ? resolveDisplayWindow(usage) : null
  const remaining = displayWindow?.remainingPercent ?? null
  const resetLabel = displayWindow === null ? null : formatCountdown(displayWindow.resetsAt, clock)
  const providerName = subscriptionProviderName(adapterId)
  const label = sub2api === undefined
    ? `${providerName} 订阅余量 ${formatPercent(remaining ?? 0)}%`
    : `${providerName} 上游余额 ${formatSub2ApiMoney(sub2api.balance, sub2api.unit)}`
  return createElement('div', { ref: rootRef, style: subscriptionRootStyle },
    createElement('button', {
      type: 'button',
      onClick: () => setOpen((value) => !value),
      disabled: loading && usage === null,
      'aria-label': label,
      'aria-expanded': open,
      style: subscriptionTriggerStyle,
    },
      sub2api === undefined
        ? createElement('span', { 'aria-hidden': true, style: progressRingStyle() },
          createElement('span', { style: { ...progressRingVisualStyle, background: progressRingVisualBackground(remaining === null ? 0 : remaining / 100, false) } },
            createElement('span', { style: progressRingValueStyle },
              createElement('span', undefined, formatRingPercentage(remaining ?? 0)),
              createElement('span', { style: progressRingSuffixStyle }, '%'),
            ),
          ),
        )
        : createElement('span', { 'aria-hidden': true, style: sub2apiIdentityStyle },
          sub2api.logoUrl !== '' && createElement('img', { src: sub2api.logoUrl, alt: '', width: 20, height: 20, style: sub2apiLogoStyle }),
          createElement('span', undefined, formatSub2ApiMoney(sub2api.balance, sub2api.unit)),
        ),
      createElement('span', { className: 'bOPqQW_label', style: subscriptionLabelStyle },
        sub2api === undefined ? (resetLabel ?? '订阅余量') : `今日费用 ${formatSub2ApiMoney(sub2api.today.cost, sub2api.unit)}`,
      ),
    ),
    open && createElement(SubscriptionPopover, { usage, providerName }),
  )
}

function SubscriptionPopover({ usage, providerName }: { readonly usage: CliSubscriptionUsage; readonly providerName: string }): ReactElement {
  if (usage.sub2api !== undefined) return createElement(Sub2ApiPopover, { usage: usage.sub2api, providerName })
  const windows = [
    ['5 小时额度', usage.primary],
    ['周额度', usage.secondary],
    ['月额度', usage.monthly],
  ] as const
  return createElement('div', { role: 'dialog', 'aria-label': `${providerName} 订阅使用情况`, style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, `${providerName} 订阅`),
      usage.planType && createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatPlanType(usage.planType)),
    ),
    ...windows.map(([label, window]) => window === null ? null : createElement('section', { key: label, style: windowStyle },
      createElement('div', { style: windowHeadingStyle }, createElement('span', undefined, label), createElement('span', undefined, `${formatPercent(window.remainingPercent)}%`)),
      createElement('div', { role: 'progressbar', 'aria-label': `${label}剩余 ${formatPercent(window.remainingPercent)}%`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': window.remainingPercent, style: barStyle },
        createElement('span', { style: { ...barFillStyle, width: `${window.remainingPercent}%` } }),
      ),
      window.resetsAt !== null && createElement('div', { style: resetStyle }, `重置于 ${formatCountdown(window.resetsAt)}`),
    )),
  )
}

function Sub2ApiPopover({ usage, providerName }: { readonly usage: Sub2ApiUsage; readonly providerName: string }): ReactElement {
  return createElement('div', { role: 'dialog', 'aria-label': `${providerName} 上游用量`, style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, `${providerName} 上游用量`),
      createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatSub2ApiMoney(usage.balance, usage.unit)),
    ),
    createElement('div', { style: sub2apiStatsGridStyle },
      createSub2ApiStat('今日请求数', formatInteger(usage.today.requests)),
      createSub2ApiStat('今日 Token 用量', formatSub2ApiTokens(usage.today.totalTokens)),
      createSub2ApiStat('今日费用', formatSub2ApiMoney(usage.today.cost, usage.unit)),
      createSub2ApiStat('累计请求数', formatInteger(usage.total.requests)),
      createSub2ApiStat('累计 Token 用量', formatSub2ApiTokens(usage.total.totalTokens)),
      createSub2ApiStat('累计费用', formatSub2ApiMoney(usage.total.cost, usage.unit)),
      createSub2ApiStat('今日缓存命中率', formatSub2ApiPercent(usage.today.cacheHitRate)),
      createSub2ApiStat('累计缓存命中率', formatSub2ApiPercent(usage.total.cacheHitRate)),
    ),
    createElement('section', { style: sub2apiSectionStyle },
      createElement('strong', { style: sub2apiSectionTitleStyle }, '按模型统计'),
      usage.models.length === 0
        ? createElement('div', { style: resetStyle }, '暂无按模型统计')
        : createElement('div', { style: sub2apiTableScrollStyle },
          createElement('table', { style: sub2apiTableStyle },
            createElement('thead', undefined, createElement('tr', undefined,
              createElement('th', { style: sub2apiThStyle }, '模型'),
              createElement('th', { style: sub2apiThStyle }, '请求'),
              createElement('th', { style: sub2apiThStyle }, 'Token'),
              createElement('th', { style: sub2apiThStyle }, '费用'),
              createElement('th', { style: sub2apiThStyle }, '缓存'),
            )),
            createElement('tbody', undefined, ...usage.models.map((model) => createModelRow(model, usage.unit))),
          ),
        ),
    ),
  )
}

function createSub2ApiStat(label: string, value: string): ReactElement {
  return createElement('div', { style: sub2apiStatStyle },
    createElement('span', { style: sub2apiStatLabelStyle }, label),
    createElement('strong', undefined, value),
  )
}

function createModelRow(model: Sub2ApiModelUsage, unit: string): ReactElement {
  return createElement('tr', { key: model.model },
    createElement('td', { style: sub2apiTdStyle }, model.model),
    createElement('td', { style: sub2apiTdStyle }, formatInteger(model.requests)),
    createElement('td', { style: sub2apiTdStyle }, formatSub2ApiTokens(model.totalTokens)),
    createElement('td', { style: sub2apiTdStyle }, formatSub2ApiMoney(model.cost, unit)),
    createElement('td', { style: sub2apiTdStyle }, formatSub2ApiPercent(model.cacheHitRate)),
  )
}

function resolveDisplayWindow(usage: CliSubscriptionUsage): CliSubscriptionWindow | null {
  return usage.primary ?? usage.secondary ?? usage.monthly
}
function isSubscriptionAdapter(adapterId: unknown): adapterId is 'command-code' | 'codex' | 'claude-code' | 'dsh' | 'grok' | 'opencode' {
  return adapterId === 'command-code' || adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'dsh' || adapterId === 'grok' || adapterId === 'opencode'
}
function subscriptionProviderName(adapterId: string | null): string {
  switch (adapterId) {
    case 'command-code': return 'Command Code'
    case 'codex': return 'Codex'
    case 'claude-code': return 'Claude Code'
    case 'dsh': return 'DSH'
    case 'grok': return 'Grok'
    case 'opencode': return 'OpenCode'
    default: return 'Agent'
  }
}
function formatPercent(value: number): string { return Math.max(0, Math.min(100, value)).toFixed(0) }
function formatRingPercentage(value: number): string { return String(Math.floor(Math.max(0, Math.min(100, value)))) }
function formatSub2ApiMoney(value: number, unit: string): string { return `${value.toFixed(2)}${unit.trim() === '' ? '' : ` ${unit.trim()}`}` }
function formatSub2ApiTokens(value: number): string { return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function formatSub2ApiPercent(value: number): string { return `${Math.max(0, Math.min(100, value)).toFixed(1)}%` }
function formatInteger(value: number): string { return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value))) }
function formatPlanType(value: string): string { return value.replace(/^individual-/u, '').replace(/(^|-)([a-z])/gu, (_match, _separator, letter: string) => ` ${letter.toUpperCase()}`).trim() }
function formatCountdown(timestampSeconds: number | null, nowMs = Date.now()): string | null {
  if (timestampSeconds === null) return null
  const minutes = Math.max(0, Math.ceil((timestampSeconds * 1000 - nowMs) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const remainder = minutes % 60
  if (days > 0) return `${days}天${hours}小时后`
  if (hours > 0) return `${hours}小时${remainder > 0 ? `${remainder}分钟` : ''}后`
  return `${remainder}分钟后`
}

const subscriptionRootStyle = { position: 'relative' as const, minWidth: 0, display: 'inline-flex', alignItems: 'center' }
const subscriptionTriggerStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, border: 0, borderRadius: 14, padding: '0 8px 0 4px', color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: 13, lineHeight: '20px' }
const subscriptionLabelStyle = { whiteSpace: 'nowrap' as const }
const sub2apiIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' }
const sub2apiLogoStyle = { display: 'block', borderRadius: 4, objectFit: 'contain' as const }
const progressRingVisualStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 2, borderRadius: 'inherit' }
const progressRingValueStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, borderRadius: 'inherit', background: dshThemeColor.menuBackground, fontSize: 7, lineHeight: 1, fontWeight: 700, color: dshThemeColor.labelPrimary, whiteSpace: 'nowrap' as const }
const progressRingSuffixStyle = { fontSize: 5.5, lineHeight: 1, color: dshThemeColor.labelTertiary, transform: 'translateY(1px)' }
const popoverHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}`, fontSize: 14 }
const windowStyle = { display: 'grid', gap: 6, paddingTop: 10 }
const windowHeadingStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: 13 }
const barStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const barFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const resetStyle = { color: dshThemeColor.labelTertiary, fontSize: 12 }
const subscriptionPopoverStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1200, bottom: 'calc(100% + 8px)', left: 0, width: 280, maxWidth: 'min(320px, calc(100vw - 24px))', padding: 14, borderRadius: 12 }
const sub2apiStatsGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, paddingTop: 12 }
const sub2apiStatStyle = { display: 'grid', gap: 2, minWidth: 0 }
const sub2apiStatLabelStyle = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const sub2apiSectionStyle = { display: 'grid', gap: 8, paddingTop: 14 }
const sub2apiSectionTitleStyle = { fontSize: 12, color: dshThemeColor.labelSecondary }
const sub2apiTableScrollStyle = { overflowX: 'auto' as const, maxWidth: '100%' }
const sub2apiTableStyle = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 11, whiteSpace: 'nowrap' as const }
const sub2apiThStyle = { padding: '4px 5px', textAlign: 'left' as const, color: dshThemeColor.labelTertiary, fontWeight: 500 }
const sub2apiTdStyle = { padding: '5px', borderTop: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelSecondary }
function progressRingStyle(): Record<string, string | number> { return { position: 'relative', display: 'inline-flex', flex: '0 0 28px', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', padding: 0, border: 0, boxShadow: `inset 0 0 0 1px ${dshThemeColor.border}`, background: 'transparent' } }
function progressRingVisualBackground(progress: number, loading: boolean): string { return loading ? dshThemeColor.border : `conic-gradient(${dshThemeColor.accent} ${Math.max(0, Math.min(1, progress)) * 360}deg, ${dshThemeColor.border} 0deg)` }

export { CommandCodeSubscriptionSlot }
export const registerCommandCodeSubscriptionSlot = registerSubscriptionSlot

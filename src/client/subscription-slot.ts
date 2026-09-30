import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { isSubscriptionUsageFresh } from '../shared/contracts/subscription.js'
import type { CliSubscriptionUsage, CliSubscriptionWindow, DeepseekUsage, ProviderBalanceUsage, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../shared/contracts/subscription.js'
import { DEFAULT_SUBSCRIPTION_USAGE_SETTINGS } from '../shared/contracts/config.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { providerIconUrl } from './provider-icons.js'
import { subscribeSessionAdapters } from './session-adapter-cache.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import type { SessionSnapshot } from './cli-slots.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    sessionId: string
  }
}

type SessionSelector = <Selected>(selector: (value: SessionSnapshot) => Selected) => Selected

interface SubscriptionSlotProps {
  readonly rpc: CodingNsRpcClient
  readonly sessionId?: string
  readonly useSession?: SessionSelector
  /** 读取当前自动查询间隔（分钟）；缺省或 0 表示不自动查询。 */
  readonly getRefreshIntervalMins?: () => number
  /** DSH 语言服务；缺省时退回内置中文词典（仅单测或非 Cordis 宿主）。 */
  readonly locale?: CodingNsLocale
}

const SUBSCRIPTION_STYLE_ID = 'codingns4dsh-subscription-responsive-style'

/**
 * 没有 locale 服务时的静态兜底：命名空间绑定固定指向内置中文词典，
 * 且不产生任何语言变更通知。生产路径由 registerSubscriptionSlot 注入 DSH locale。
 */
const FALLBACK_LOCALE = {
  bind: () => resolveCodingNsTranslator(undefined),
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => {},
  register: () => () => {},
} as unknown as CodingNsLocale

/**
 * 进程内用量结果缓存：同一适配器/提供商在刷新间隔内直接复用上次结果，
 * 避免每次进入会话或切回同一 Agent 都请求上游；null 结果不缓存，便于刚登录后立刻重试。
 */
const subscriptionUsageCache = new Map<string, { readonly usage: CliSubscriptionUsage; readonly capturedAt: number }>()

/** 移动端订阅入口只保留图标，完整数据仍可在点击后的弹层中查看。 */
function installSubscriptionStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${SUBSCRIPTION_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = SUBSCRIPTION_STYLE_ID
  style.textContent = '@media (max-width: 768px){.codingns4dsh-subscription-trigger{gap:0!important;padding-left:4px!important;padding-right:4px!important}.codingns4dsh-subscription-label,.codingns4dsh-subscription-value{display:none!important}.codingns4dsh-subscription-popover{position:fixed!important;left:12px!important;right:12px!important;bottom:48px!important;width:auto!important;min-width:0!important;max-width:none!important;max-height:calc(100vh - 72px)!important;overflow:auto!important}}'
  document.head.appendChild(style)
}

/** 在 DSH 原生步骤统计左侧显示当前 Agent 的订阅余量。 */
export function registerSubscriptionSlot(slots: SlotRegistry, rpc: CodingNsRpcClient, getRefreshIntervalMins?: () => number, locale?: CodingNsLocale): () => void {
  installSubscriptionStyles()
  const t = resolveCodingNsTranslator(locale)
  return slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'codingns4dsh-subscription',
    order: -20,
    label: t('usage.slotLabel'),
    inject: (sessionId: string) => ({
      rpc,
      sessionId,
      locale: locale ?? FALLBACK_LOCALE,
      ...(getRefreshIntervalMins === undefined ? {} : { getRefreshIntervalMins }),
    }),
  }, CommandCodeSubscriptionSlot))
}

function CommandCodeSubscriptionSlot(props: SubscriptionSlotProps): ReactElement | null {
  const t = useCodingNsTranslator(props.locale ?? FALLBACK_LOCALE)
  const [usage, setUsage] = useState<CliSubscriptionUsage | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [eligible, setEligible] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const modelSelectionRevision = props.useSession?.((value) => JSON.stringify(value.modelSelection))
  // 切换 Agent 可能只改变 Host 侧会话配置，DSH 会话快照不一定会更新；订阅适配器
  // 缓存的变更才能真正触发重新查询，否则底部会一直显示上一个 Agent 的订阅数据。
  const [adapterRevision, bumpAdapterRevision] = useState(0)
  useEffect(() => subscribeSessionAdapters(() => { bumpAdapterRevision((value) => value + 1) }), [])

  useEffect(() => {
    const sessionId = props.sessionId?.trim()
    if (!sessionId) {
      setEligible(false)
      setUsage(null)
      setAdapterId(null)
      setProviderId(null)
      setOpen(false)
      return
    }
    let active = true
    setEligible(false)
    setUsage(null)
    setAdapterId(null)
    setProviderId(null)
    setOpen(false)
    const refresh = async (): Promise<void> => {
      setLoading(true)
      try {
        const selection = await callCliRpc<{ readonly adapterId?: string; readonly providerId?: string }>(props.rpc, 'session/get', { sessionId })
        const adapterId = selection.adapterId
        if (!active || !isSubscriptionAdapter(adapterId)) {
          if (active) {
            setEligible(false)
            setUsage(null)
            setAdapterId(null)
            setProviderId(null)
          }
          return
        }
        if (active) {
          setEligible(true)
          setAdapterId(adapterId)
          setProviderId(selection.providerId ?? null)
        }
        const intervalMins = props.getRefreshIntervalMins?.() ?? DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins
        const cacheKey = `${adapterId}|${selection.providerId ?? ''}`
        const cached = subscriptionUsageCache.get(cacheKey)
        if (cached !== undefined && isSubscriptionUsageFresh(cached.capturedAt, Date.now(), intervalMins)) {
          if (active) setUsage(cached.usage)
          return
        }
        const next = await callCliRpc<CliSubscriptionUsage | null>(props.rpc, 'subscription', {
          adapterId,
          ...(selection.providerId ? { providerId: selection.providerId } : {}),
        })
        if (next !== null) subscriptionUsageCache.set(cacheKey, { usage: next, capturedAt: Date.now() })
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
    const intervalMins = props.getRefreshIntervalMins?.() ?? DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins
    const timer = intervalMins > 0 ? globalThis.setInterval(() => { void refresh() }, intervalMins * 60_000) : undefined
    return () => {
      active = false
      if (timer !== undefined) globalThis.clearInterval(timer)
    }
  }, [props.rpc, props.sessionId, props.getRefreshIntervalMins, modelSelectionRevision, adapterRevision])

  useEffect(() => {
    if (!eligible || usage === null) return
    const timer = globalThis.setInterval(() => setClock(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [eligible, usage])

  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false))

  // 未拿到真实订阅数据时不占用底部栏空间；加载状态不能伪装成订阅存在。
  if (!eligible || usage === null || (usage.sub2api === undefined && usage.deepseek === undefined && usage.providerBalance === undefined && resolveDisplayWindow(usage) === null)) return null
  const sub2api = usage.sub2api
  const deepseek = usage.deepseek
  const providerBalance = usage.providerBalance
  const displayWindow = sub2api === undefined && deepseek === undefined && providerBalance === undefined ? resolveDisplayWindow(usage) : null
  const remaining = displayWindow?.remainingPercent ?? null
  const resetLabel = displayWindow === null ? null : formatCountdown(displayWindow.resetsAt, t, clock)
  const providerName = subscriptionProviderName(adapterId, providerId, usage, t)
  const deepseekBalance = deepseek === undefined ? null : selectDeepseekBalance(deepseek)
  const providerLogoSource = usage.provider?.logoDataUrl ?? (isRemoteWebContext() ? '' : usage.provider?.logoUrl ?? '')
  const deepseekIconSource = providerLogoSource || (providerBalance === undefined ? providerIconUrl('dsh') : '')
  const label = sub2api === undefined && deepseek === undefined && providerBalance === undefined
    ? t('usage.remainingLabel', { provider: providerName, percent: formatPercent(remaining ?? 0) })
    : sub2api !== undefined
      ? t('usage.upstreamBalanceLabel', { provider: providerName, amount: formatSub2ApiMoney(sub2api.balance, sub2api.unit) })
      : deepseek !== undefined
        ? t('usage.balanceLabel', { provider: providerName, amount: deepseekBalance === null ? t('usage.unavailable') : formatDeepseekMoney(deepseekBalance.totalBalance, deepseekBalance.currency) })
        : t('usage.providerBalanceLabel', { provider: providerName, amount: formatProviderBalance(providerBalance) })
  const logoSource = providerLogoSource || (sub2api === undefined ? '' : (sub2api.logoDataUrl ?? (isRemoteWebContext() ? '' : sub2api.logoUrl)))
  const triggerContent = sub2api === undefined && deepseek === undefined && providerBalance === undefined
    ? createElement('span', { 'aria-hidden': true, style: progressRingStyle() },
      createElement('span', { style: { ...progressRingVisualStyle, background: progressRingVisualBackground(remaining === null ? 0 : remaining / 100, false) } },
        createElement('span', { style: progressRingValueStyle },
          createElement('span', undefined, formatRingPercentage(remaining ?? 0)),
          createElement('span', { style: progressRingSuffixStyle }, '%'),
        ),
      ),
    )
    : sub2api !== undefined
      ? createElement('span', { 'aria-hidden': true, style: sub2apiIdentityStyle },
        createElement('img', { src: logoSource || providerIconUrl(adapterId ?? 'dsh') || '', alt: '', width: 20, height: 20, style: sub2apiLogoStyle }),
        createElement('span', { className: 'codingns4dsh-subscription-value' }, formatSub2ApiMoney(sub2api.balance, sub2api.unit)),
      )
      : deepseek !== undefined
        ? createElement('span', { 'aria-hidden': true, style: deepseekBalanceIdentityStyle },
        deepseekIconSource !== undefined && createElement('img', { src: deepseekIconSource, alt: '', width: 18, height: 18, style: deepseekLogoStyle }),
        createElement('span', { className: 'codingns4dsh-subscription-value', style: deepseekBalanceStyle }, deepseekBalance === null ? '--' : formatDeepseekMoney(deepseekBalance.totalBalance, deepseekBalance.currency)),
        )
        : createElement('span', { 'aria-hidden': true, style: deepseekBalanceIdentityStyle },
          deepseekIconSource !== undefined && createElement('img', { src: deepseekIconSource, alt: '', width: 18, height: 18, style: deepseekLogoStyle }),
          createElement('span', { className: 'codingns4dsh-subscription-value', style: deepseekBalanceStyle }, formatProviderBalance(providerBalance)),
        )
  return createElement('div', { ref: rootRef, style: subscriptionRootStyle },
    createElement('button', {
      type: 'button',
      className: 'codingns4dsh-subscription-trigger',
      onClick: () => setOpen((value) => !value),
      disabled: loading && usage === null,
      'aria-label': label,
      'aria-expanded': open,
      style: subscriptionTriggerStyle,
    },
      triggerContent,
      createElement('span', { className: 'codingns4dsh-subscription-label', style: subscriptionLabelStyle },
        sub2api === undefined && deepseek === undefined && providerBalance === undefined
          ? (resetLabel ?? t('usage.subscriptionRemaining'))
          : sub2api !== undefined ? t('usage.todayCostShort', { amount: formatSub2ApiMoney(sub2api.today.cost, sub2api.unit) }) : deepseek !== undefined ? t('usage.accountBalance') : t('usage.officialRemaining'),
      ),
    ),
    open && createElement(SubscriptionPopover, { usage, providerName, t }),
  )
}

function SubscriptionPopover({ usage, providerName, t }: { readonly usage: CliSubscriptionUsage; readonly providerName: string; readonly t: CodingNsTranslator }): ReactElement {
  if (usage.sub2api !== undefined) return createElement(Sub2ApiPopover, { usage: usage.sub2api, providerName, t })
  if (usage.deepseek !== undefined) return createElement(DeepseekPopover, { usage: usage.deepseek, providerName, t })
  if (usage.providerBalance !== undefined) return createElement(ProviderBalancePopover, { usage: usage.providerBalance, providerName, t })
  const windows = [
    { id: 'primary', label: formatSubscriptionWindowLabel(usage.primary, t('usage.windowFiveHour'), t), window: usage.primary },
    { id: 'secondary', label: formatSubscriptionWindowLabel(usage.secondary, t('usage.windowWeekly'), t), window: usage.secondary },
    { id: 'monthly', label: formatSubscriptionWindowLabel(usage.monthly, t('usage.windowMonthly'), t), window: usage.monthly },
  ] as const
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.popoverSubscriptionUsage', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, t('usage.popoverSubscriptionTitle', { provider: providerName })),
      usage.planType && createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatPlanType(usage.planType)),
    ),
    ...windows.map(({ id, label, window }) => window === null ? null : createElement('section', { key: id, style: windowStyle },
      createElement('div', { style: windowHeadingStyle }, createElement('span', undefined, label), createElement('span', undefined, `${formatPercent(window.remainingPercent)}%`)),
      createElement('div', { role: 'progressbar', 'aria-label': t('usage.windowRemaining', { label, percent: formatPercent(window.remainingPercent) }), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': window.remainingPercent, style: barStyle },
        createElement('span', { style: { ...barFillStyle, width: `${window.remainingPercent}%` } }),
      ),
      window.resetsAt !== null && createElement('div', { style: resetStyle }, t('usage.resetsIn', { time: formatCountdown(window.resetsAt, t) })),
    )),
  )
}

/** 根据服务端返回的窗口时长生成准确的额度标签，避免把七天窗口误显示成五小时。 */
function formatSubscriptionWindowLabel(window: CliSubscriptionWindow | null, fallback: string, t: CodingNsTranslator): string {
  const durationMins = window?.windowDurationMins
  if (durationMins === null || durationMins === undefined || !Number.isFinite(durationMins) || durationMins <= 0) return fallback
  if (durationMins % (24 * 60) === 0) return t('usage.windowDays', { count: durationMins / (24 * 60) })
  if (durationMins % 60 === 0) return t('usage.windowHours', { count: durationMins / 60 })
  return t('usage.windowMinutes', { count: durationMins })
}

function ProviderBalancePopover({ usage, providerName, t }: { readonly usage: ProviderBalanceUsage; readonly providerName: string; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.officialRemainingPopover', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, t('usage.officialRemainingPopover', { provider: providerName })),
      createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatProviderBalance(usage)),
    ),
    usage.used !== null && usage.total !== null && createElement('div', { style: upstreamMetaStyle }, t('usage.usedOfTotal', { used: formatProviderBalanceValue(usage.used, usage.unit), total: formatProviderBalanceValue(usage.total, usage.unit) })),
    usage.details.length === 0
      ? createElement('div', { style: resetStyle }, t('usage.noMoreStats'))
      : usage.details.map((item) => createElement('div', { key: item.label, style: deepseekBalanceDetailsStyle }, createElement('span', undefined, item.label), createElement('span', undefined, String(item.value)))),
  )
}

function DeepseekPopover({ usage, providerName, t }: { readonly usage: DeepseekUsage; readonly providerName: string; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.providerAccountBalance', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, t('usage.providerAccountBalance', { provider: providerName })),
      createElement('span', { style: { color: usage.isAvailable === false ? dshThemeColor.error : dshThemeColor.labelTertiary } }, usage.isAvailable === false ? t('usage.unavailable') : t('usage.available')),
    ),
    usage.balances.map((balance) => createElement('section', { key: balance.currency, style: deepseekBalanceSectionStyle },
      createElement('div', { style: windowHeadingStyle }, createElement('span', undefined, balance.currency), createElement('strong', undefined, formatDeepseekMoney(balance.totalBalance, balance.currency))),
      createElement('div', { style: deepseekBalanceDetailsStyle },
        createElement('span', undefined, t('usage.granted', { amount: formatDeepseekMoney(balance.grantedBalance, balance.currency) })),
        createElement('span', undefined, t('usage.toppedUp', { amount: formatDeepseekMoney(balance.toppedUpBalance, balance.currency) })),
      ),
    )),
    createElement('div', { style: deepseekUnavailableStatsStyle }, t('usage.deepseekApiNote')),
  )
}

function Sub2ApiPopover({ usage, providerName, t }: { readonly usage: Sub2ApiUsage; readonly providerName: string; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.upstreamUsageTitle', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, t('usage.upstreamUsageTitle', { provider: providerName })),
      createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatSub2ApiMoney(usage.balance, usage.unit)),
    ),
    createElement('div', { style: upstreamMetaStyle },
      createElement('span', { style: upstreamTypeStyle }, usage.upstreamType),
      usage.upstreamUrl === ''
        ? createElement('span', { style: upstreamMutedStyle }, t('usage.addressMissing'))
        : createElement('a', { href: usage.upstreamUrl, target: '_blank', rel: 'noreferrer', title: usage.upstreamUrl, style: upstreamLinkStyle }, usage.upstreamUrl),
    ),
    createElement('div', { style: sub2apiStatsGridStyle },
      createSub2ApiStat(t('usage.statTodayRequests'), formatInteger(usage.today.requests)),
      createSub2ApiStat(t('usage.statTodayTokens'), formatSub2ApiTokens(usage.today.totalTokens)),
      createSub2ApiStat(t('usage.statTodayCost'), formatSub2ApiMoney(usage.today.cost, usage.unit)),
      createSub2ApiStat(t('usage.statTotalRequests'), formatInteger(usage.total.requests)),
      createSub2ApiStat(t('usage.statTotalTokens'), formatSub2ApiTokens(usage.total.totalTokens)),
      createSub2ApiStat(t('usage.statTotalCost'), formatSub2ApiMoney(usage.total.cost, usage.unit)),
      createSub2ApiStat(t('usage.statTodayCacheHitRate'), formatSub2ApiPercent(usage.today.cacheHitRate)),
      createSub2ApiStat(t('usage.statTotalCacheHitRate'), formatSub2ApiPercent(usage.total.cacheHitRate)),
    ),
    createElement('section', { style: sub2apiSectionStyle },
      createElement('strong', { style: sub2apiSectionTitleStyle }, t('usage.byModel')),
      usage.models.length === 0
        ? createElement('div', { style: resetStyle }, t('usage.noModelStats'))
        : createElement('div', { style: sub2apiTableScrollStyle },
          createElement('table', { style: sub2apiTableStyle },
            createElement('thead', undefined, createElement('tr', undefined,
              createElement('th', { style: sub2apiThStyle }, t('usage.colModel')),
              createElement('th', { style: sub2apiThStyle }, t('usage.colRequests')),
              createElement('th', { style: sub2apiThStyle }, t('usage.colToken')),
              createElement('th', { style: sub2apiThStyle }, t('usage.colCost')),
              createElement('th', { style: sub2apiThStyle }, t('usage.colCache')),
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
function selectDeepseekBalance(usage: DeepseekUsage): DeepseekUsage['balances'][number] | null {
  return usage.balances.find((balance) => balance.currency.toUpperCase() === 'USD') ?? usage.balances[0] ?? null
}
function isSubscriptionAdapter(adapterId: unknown): adapterId is 'command-code' | 'codex' | 'claude-code' | 'dsh' | 'grok' | 'kimi' | 'opencode' {
  return adapterId === 'command-code' || adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'dsh' || adapterId === 'grok' || adapterId === 'kimi' || adapterId === 'opencode'
}
function isRemoteWebContext(): boolean {
  return (globalThis as { __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown }).__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ === true
}
function subscriptionProviderName(adapterId: string | null, providerId: string | null, usage: CliSubscriptionUsage, t: CodingNsTranslator): string {
  if (usage.provider?.displayName) return usage.provider.displayName
  if (adapterId === 'dsh' && providerId !== null) {
    if (/^(?:deepseek(?:-official)?|official-deepseek)$/iu.test(providerId)) return t('usage.providerDeepseekOfficial')
    return formatProviderName(providerId)
  }
  if (adapterId === 'dsh' && usage.sub2api !== undefined) return t('usage.providerUpstream', { name: usage.sub2api.upstreamType })
  switch (adapterId) {
    case 'command-code': return 'Command Code'
    case 'codex': return 'Codex'
    case 'claude-code': return 'Claude Code'
    case 'dsh': return 'DSH'
    case 'grok': return 'Grok'
    case 'kimi': return 'Kimi Code'
    case 'opencode': return 'OpenCode'
    default: return 'Agent'
  }
}
function formatProviderName(value: string): string {
  return value.replace(/[-_]+/gu, ' ').replace(/(^|\s)([a-z])/gu, (_match, prefix, letter: string) => `${prefix}${letter.toUpperCase()}`)
}
function formatPercent(value: number): string { return Math.max(0, Math.min(100, value)).toFixed(0) }
function formatRingPercentage(value: number): string { return String(Math.floor(Math.max(0, Math.min(100, value)))) }
function formatSub2ApiMoney(value: number, unit: string): string {
  const normalizedUnit = unit.trim().toUpperCase()
  if (normalizedUnit === 'USD') return `$${value.toFixed(2)}`
  return `${value.toFixed(2)}${normalizedUnit === '' ? '' : ` ${normalizedUnit}`}`
}
function formatDeepseekMoney(value: number, currency: string): string {
  const normalizedCurrency = currency.trim().toUpperCase()
  const amount = value.toFixed(2)
  if (normalizedCurrency === 'USD') return `$${amount}`
  if (normalizedCurrency === 'CNY') return `¥${amount}`
  return `${amount} ${normalizedCurrency}`
}
function formatProviderBalance(usage: ProviderBalanceUsage | undefined): string {
  if (usage === undefined || usage.remaining === null) return '--'
  return formatProviderBalanceValue(usage.remaining, usage.unit)
}
function formatProviderBalanceValue(value: number, unit: string | null): string {
  const normalized = unit?.trim().toUpperCase() ?? ''
  if (normalized === '%') return `${value.toFixed(0)}%`
  if (normalized === 'USD') return `$${value.toFixed(2)}`
  return `${value.toFixed(2)}${normalized === '' ? '' : ` ${normalized}`}`
}
function formatSub2ApiTokens(value: number): string { return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function formatSub2ApiPercent(value: number): string { return `${Math.max(0, Math.min(100, value)).toFixed(1)}%` }
function formatInteger(value: number): string { return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value))) }
function formatPlanType(value: string): string { return value.replace(/^individual-/u, '').replace(/(^|-)([a-z])/gu, (_match, _separator, letter: string) => ` ${letter.toUpperCase()}`).trim() }
function formatCountdown(timestampSeconds: number | null, t: CodingNsTranslator, nowMs = Date.now()): string | null {
  if (timestampSeconds === null) return null
  const minutes = Math.max(0, Math.ceil((timestampSeconds * 1000 - nowMs) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const remainder = minutes % 60
  if (days > 0) return t('usage.countdownDaysHours', { days, hours })
  if (hours > 0) return remainder > 0 ? t('usage.countdownHoursMinutes', { hours, minutes: remainder }) : t('usage.countdownHours', { hours })
  return t('usage.countdownMinutes', { minutes: remainder })
}

const subscriptionRootStyle = { position: 'relative' as const, minWidth: 0, display: 'inline-flex', alignItems: 'center' }
const subscriptionTriggerStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, border: 0, borderRadius: 14, padding: '0 8px 0 4px', color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: 13, lineHeight: '20px' }
const subscriptionLabelStyle = { whiteSpace: 'nowrap' as const }
const sub2apiIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' }
const sub2apiLogoStyle = { display: 'block', borderRadius: 4, objectFit: 'contain' as const }
const deepseekBalanceIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const }
const deepseekLogoStyle = { display: 'block', borderRadius: 5, objectFit: 'contain' as const }
const deepseekBalanceStyle = { display: 'inline-flex', alignItems: 'center', color: dshThemeColor.labelSecondary, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const deepseekBalanceSectionStyle = { display: 'grid', gap: 6, marginTop: 10, padding: '10px 0 2px', borderTop: `1px solid ${dshThemeColor.border}` }
const deepseekBalanceDetailsStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: 12 }
const deepseekUnavailableStatsStyle = { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelTertiary, fontSize: 12, lineHeight: '17px' }
const progressRingVisualStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 2, borderRadius: 'inherit' }
const progressRingValueStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, borderRadius: 'inherit', background: dshThemeColor.menuBackground, fontSize: 7, lineHeight: 1, fontWeight: 700, color: dshThemeColor.labelPrimary, whiteSpace: 'nowrap' as const }
const progressRingSuffixStyle = { fontSize: 5.5, lineHeight: 1, color: dshThemeColor.labelTertiary, transform: 'translateY(1px)' }
const popoverHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}`, fontSize: 14 }
const upstreamMetaStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingTop: 8, color: dshThemeColor.labelTertiary, fontSize: 11, lineHeight: '16px' }
const upstreamTypeStyle = { flex: '0 0 auto', color: dshThemeColor.labelSecondary, fontWeight: 600 }
const upstreamLinkStyle = { minWidth: 0, overflow: 'hidden', color: dshThemeColor.accent, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textDecoration: 'none' }
const upstreamMutedStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' as const }
const windowStyle = { display: 'grid', gap: 6, paddingTop: 10 }
const windowHeadingStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: 13 }
const barStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const barFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const resetStyle = { color: dshThemeColor.labelTertiary, fontSize: 12 }
const subscriptionPopoverStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1200, bottom: 'calc(100% + 8px)', left: 0, width: 'max-content', minWidth: 280, maxWidth: 'min(400px, calc(100vw - 24px))', boxSizing: 'border-box' as const, padding: 14, borderRadius: 12 }
const sub2apiStatsGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, paddingTop: 12 }
const sub2apiStatStyle = { display: 'grid', gap: 2, minWidth: 0 }
const sub2apiStatLabelStyle = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const sub2apiSectionStyle = { display: 'grid', gap: 8, paddingTop: 14 }
const sub2apiSectionTitleStyle = { fontSize: 12, color: dshThemeColor.labelSecondary }
const sub2apiTableScrollStyle = { maxWidth: '100%', overflow: 'visible' as const }
const sub2apiTableStyle = { width: '100%', tableLayout: 'fixed' as const, borderCollapse: 'collapse' as const, fontSize: 11 }
const sub2apiThStyle = { padding: '4px 5px', textAlign: 'left' as const, color: dshThemeColor.labelTertiary, fontWeight: 500 }
const sub2apiTdStyle = { padding: '5px', borderTop: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelSecondary, overflowWrap: 'anywhere' as const }
function progressRingStyle(): Record<string, string | number> { return { position: 'relative', display: 'inline-flex', flex: '0 0 28px', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', padding: 0, border: 0, boxShadow: `inset 0 0 0 1px ${dshThemeColor.border}`, background: 'transparent' } }
function progressRingVisualBackground(progress: number, loading: boolean): string { return loading ? dshThemeColor.border : `conic-gradient(${dshThemeColor.accent} ${Math.max(0, Math.min(1, progress)) * 360}deg, ${dshThemeColor.border} 0deg)` }

export { CommandCodeSubscriptionSlot }
export const registerCommandCodeSubscriptionSlot = registerSubscriptionSlot

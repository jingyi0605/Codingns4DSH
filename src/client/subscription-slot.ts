import { startSerialPolling } from './serial-polling.js'
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { isSubscriptionUsageFresh } from '../shared/contracts/subscription.js'
import type { CliSubscriptionGroup, CliSubscriptionGroupWindow, CliSubscriptionResetOutcome, CliSubscriptionResetResult, CliSubscriptionUsage, CliSubscriptionWindow, DeepseekUsage, ProviderBalanceUsage, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../shared/contracts/subscription.js'
import { DEFAULT_SUBSCRIPTION_USAGE_SETTINGS } from '../shared/contracts/config.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { providerIconUrl } from './provider-icons.js'
import { subscribeSessionAdapters } from './session-adapter-cache.js'
import { dshPopupSurfaceStyle, dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from './theme.js'
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
type UsageCache = Map<string, { readonly usage: CliSubscriptionUsage; readonly capturedAt: number }>
const usageCaches = new WeakMap<CodingNsRpcClient, UsageCache>()
const usageLoads = new WeakMap<CodingNsRpcClient, Map<string, Promise<CliSubscriptionUsage | null>>>()
function usageCache(rpc: CodingNsRpcClient): UsageCache {
  let cache = usageCaches.get(rpc)
  if (cache === undefined) { cache = new Map(); usageCaches.set(rpc, cache) }
  return cache
}

/** 重置影响同一账号的所有模型额度，不能只删除不含模型的旧缓存键。 */
export function invalidateSubscriptionUsageCache(cache: Pick<UsageCache, 'keys' | 'delete'>, adapterId: string, providerId: string | null): void {
  const prefix = `${adapterId}|${providerId ?? ''}|`
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}

function loadUsage(rpc: CodingNsRpcClient, key: string, payload: unknown): Promise<CliSubscriptionUsage | null> {
  let loads = usageLoads.get(rpc)
  if (loads === undefined) { loads = new Map(); usageLoads.set(rpc, loads) }
  const existing = loads.get(key)
  if (existing !== undefined) return existing
  const request = callCliRpc<CliSubscriptionUsage | null>(rpc, 'subscription', payload, AbortSignal.timeout(30_000))
    .finally(() => { if (loads.get(key) === request) loads.delete(key) })
  loads.set(key, request)
  return request
}

/** 图标重置按钮的悬停/按下/聚焦/禁用只能由注入样式表表达，内联样式无法命中伪类。 */
const RESET_BUTTON_CSS = '.codingns4dsh-subscription-reset{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer;transition:background .15s ease,color .15s ease}.codingns4dsh-subscription-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}.codingns4dsh-subscription-reset:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.14))}.codingns4dsh-subscription-reset:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1677ff))}.codingns4dsh-subscription-reset:disabled{opacity:.4;cursor:not-allowed}@media (prefers-reduced-motion: reduce){.codingns4dsh-subscription-reset{transition:none}}'

/** 移动端订阅入口只保留图标，完整数据仍可在点击后的弹层中查看。 */
function installSubscriptionStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${SUBSCRIPTION_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = SUBSCRIPTION_STYLE_ID
  style.textContent = '@media (max-width: 768px){.codingns4dsh-subscription-trigger{gap:0!important;padding-left:4px!important;padding-right:4px!important}.codingns4dsh-subscription-label,.codingns4dsh-subscription-value{display:none!important}.codingns4dsh-subscription-popover{position:fixed!important;left:12px!important;right:12px!important;bottom:48px!important;width:auto!important;min-width:0!important;max-width:none!important;max-height:calc(100vh - 72px)!important;overflow:auto!important}}' + RESET_BUTTON_CSS
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
  const subscriptionUsageCache = usageCache(props.rpc)
  const [usage, setUsage] = useState<CliSubscriptionUsage | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [eligible, setEligible] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const resetDialogRef = useRef<HTMLDivElement>(null)
  // 重置成功后的刷新不能重跑加载 effect，否则 usage 会被清空导致底部入口闪断。
  const refreshRef = useRef<null | (() => Promise<void>)>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [resetResult, setResetResult] = useState<CliSubscriptionResetOutcome | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
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
      setResetOpen(false)
      setResetPending(false)
      setResetResult(null)
      setResetError(null)
      return
    }
    let active = true
    setEligible(false)
    setUsage(null)
    setAdapterId(null)
    setProviderId(null)
    setOpen(false)
    setResetOpen(false)
    setResetPending(false)
    setResetResult(null)
    setResetError(null)
    const refresh = async (signal: AbortSignal): Promise<boolean | void> => {
      setLoading(true)
      try {
        const selection = await callCliRpc<{ readonly adapterId?: string; readonly providerId?: string; readonly modelId?: string }>(props.rpc, 'session/get', { sessionId }, signal)
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
        // 模型也是读取键的一部分：Antigravity 的 Gemini 与 Claude/GPT 是两个独立配额组。
        const cacheKey = `${adapterId}|${selection.providerId ?? ''}|${selection.modelId ?? ''}`
        const cached = subscriptionUsageCache.get(cacheKey)
        // New-API 的余额和 Token 日志可能随 Key/钱包状态快速变化，且旧结果
        // 容易把历史日志投影到当前站点；每次刷新都重新读取，Sub2API 仍复用原缓存。
        const canReuseCachedUsage = cached !== undefined && cached.usage.provider?.capability !== 'new-api'
        if (canReuseCachedUsage && isSubscriptionUsageFresh(cached.capturedAt, Date.now(), intervalMins)) {
          if (active) setUsage(cached.usage)
          return
        }
        const next = await loadUsage(props.rpc, cacheKey, {
          adapterId,
          ...(selection.providerId ? { providerId: selection.providerId } : {}),
          ...(selection.modelId ? { modelId: selection.modelId } : {}),
        })
        if (next !== null) subscriptionUsageCache.set(cacheKey, { usage: next, capturedAt: Date.now() })
        if (active) setUsage(next)
      } catch {
        if (active) {
          setEligible(false)
          setUsage(null)
        }
        return false
      } finally {
        if (active) setLoading(false)
      }
    }
    const intervalMins = props.getRefreshIntervalMins?.() ?? DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins
    const poll = startSerialPolling(refresh, Math.max(0, intervalMins) * 60_000, { timeoutMs: 30_000 })
    refreshRef.current = poll.refresh
    return () => {
      active = false
      refreshRef.current = null
      poll.dispose()
    }
  }, [props.rpc, props.sessionId, props.getRefreshIntervalMins, modelSelectionRevision, adapterRevision])

  useEffect(() => {
    if (!eligible || usage === null) return
    const timer = globalThis.setInterval(() => setClock(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [eligible, usage])

  const closeResetDialog = (): void => {
    if (resetPending) return
    setResetOpen(false)
    setResetResult(null)
    setResetError(null)
  }

  const confirmReset = (): void => {
    if (resetPending || adapterId === null) return
    setResetPending(true)
    setResetError(null)
    void (async () => {
      try {
        const result = await callCliRpc<CliSubscriptionResetResult>(props.rpc, 'subscription/reset', {
          adapterId,
          ...(providerId === null ? {} : { providerId }),
        })
        setResetResult(result.outcome)
        // 重置改变了窗口与次数，必须绕过进程内缓存重新读取。
        invalidateSubscriptionUsageCache(subscriptionUsageCache, adapterId, providerId)
        await refreshRef.current?.()
      } catch (error) {
        setResetError(error instanceof Error ? error.message : '')
      } finally {
        setResetPending(false)
      }
    })()
  }

  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false))
  useDismissOnOutsidePointer(resetDialogRef, resetOpen && !resetPending, closeResetDialog)

  // 未拿到真实订阅数据时不占用底部栏空间；加载状态不能伪装成订阅存在。
  if (!eligible || usage === null || (usage.sub2api === undefined && usage.deepseek === undefined && usage.providerBalance === undefined && resolveDisplayWindow(usage) === null)) return null
  const sub2api = usage.sub2api
  const deepseek = usage.deepseek
  const providerBalance = usage.providerBalance
  const isNewApiProvider = providerBalance !== undefined && usage.provider?.capability === 'new-api'
  const displayWindow = sub2api === undefined && deepseek === undefined && providerBalance === undefined ? resolveDisplayWindow(usage) : null
  const remaining = displayWindow?.remainingPercent ?? null
  const resetLabel = displayWindow === null ? null : formatCountdown(displayWindow.resetsAt, t, clock)
  const providerName = subscriptionProviderName(adapterId, providerId, usage, t)
  const deepseekBalance = deepseek === undefined ? null : selectDeepseekBalance(deepseek)
  const providerBalanceRemaining = providerBalance === undefined ? null : balancePercent(providerBalance.remaining, providerBalance.total)
  const providerBalancePlan = providerBalance?.planName?.trim() || null
  const newApiHeadline = isNewApiProvider && providerBalance !== undefined ? formatNewApiHeadline(providerBalance) : null
  // 官方余额读取器可能没有可直连的 Provider Logo；此时统一回退到当前
  // 适配器注册的内置图标，ZCode 等 Agent 不再显示空 src 的破图。
  const adapterIconSource = providerIconUrl(adapterId ?? 'dsh') ?? ''
  const providerLogoSource = usage.provider?.logoDataUrl?.trim() || (!isRemoteWebContext() ? usage.provider?.logoUrl?.trim() : '') || adapterIconSource
  const deepseekIconSource = providerLogoSource
  const label = sub2api === undefined && deepseek === undefined && providerBalance === undefined
    ? t('usage.remainingLabel', { provider: providerName, percent: formatPercent(remaining ?? 0) })
    : sub2api !== undefined
      ? t('usage.upstreamBalanceLabel', { provider: providerName, amount: formatSub2ApiMoney(sub2api.balance, sub2api.unit) })
      : deepseek !== undefined
        ? t('usage.balanceLabel', { provider: providerName, amount: deepseekBalance === null ? t('usage.unavailable') : formatDeepseekMoney(deepseekBalance.totalBalance, deepseekBalance.currency) })
        : isNewApiProvider
          ? newApiHeadline === null ? providerName : `${providerName} ${newApiHeadline}`
          : providerBalancePlan === null
            ? t('usage.providerBalanceLabel', { provider: providerName, amount: formatProviderBalance(providerBalance, t('usage.upstreamNotProvided')) })
            : t('usage.providerBalancePlanLabel', { provider: providerName, plan: providerBalancePlan, amount: formatProviderBalance(providerBalance, t('usage.upstreamNotProvided')) })
  const logoSource = providerLogoSource || (sub2api === undefined ? '' : (sub2api.logoDataUrl ?? (isRemoteWebContext() ? '' : sub2api.logoUrl)))
  const resetCredits = usage.resetCredits
  // 重置只对官方 Codex 订阅开放；第三方上游走 sub2api 面板，不会带出重置券。
  const resetRequest = adapterId === 'codex' && resetCredits !== null
    ? {
        enabled: resetCredits.availableCount > 0 && !resetPending,
        onRequest: (): void => {
          setOpen(false)
          setResetResult(null)
          setResetError(null)
          setResetOpen(true)
        },
      }
    : null
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
        deepseekIconSource !== '' && createElement('img', { src: deepseekIconSource, alt: '', width: 18, height: 18, style: deepseekLogoStyle }),
        createElement('span', { className: 'codingns4dsh-subscription-value', style: deepseekBalanceStyle }, deepseekBalance === null ? '--' : formatDeepseekMoney(deepseekBalance.totalBalance, deepseekBalance.currency)),
        )
        : isNewApiProvider
          ? createElement('span', { 'aria-hidden': true, style: deepseekBalanceIdentityStyle },
            deepseekIconSource !== '' && createElement('img', { src: deepseekIconSource, alt: '', width: 18, height: 18, style: deepseekLogoStyle }),
            newApiHeadline !== null && createElement('span', { className: 'codingns4dsh-subscription-value', style: deepseekBalanceStyle }, newApiHeadline),
          )
          : providerBalanceRemaining !== null
          ? createRemainingRing(providerBalanceRemaining)
          : createElement('span', { 'aria-hidden': true, style: deepseekBalanceIdentityStyle },
            deepseekIconSource !== '' && createElement('img', { src: deepseekIconSource, alt: '', width: 18, height: 18, style: deepseekLogoStyle }),
            createElement('span', { className: 'codingns4dsh-subscription-value', style: deepseekBalanceStyle }, formatProviderBalance(providerBalance, t('usage.upstreamNotProvided'))),
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
          : sub2api !== undefined ? t('usage.todayCostShort', { amount: formatSub2ApiMoney(sub2api.today.cost, sub2api.unit) }) : deepseek !== undefined ? t('usage.accountBalance') : isNewApiProvider ? providerName : providerBalancePlan ?? t('usage.officialRemaining'),
      ),
    ),
    open && createElement(SubscriptionPopover, { usage, providerName, t, nowMs: clock, reset: resetRequest }),
    resetOpen && createElement(ResetConfirmDialog, {
      count: resetCredits?.availableCount ?? 0,
      pending: resetPending,
      result: resetResult,
      error: resetError,
      t,
      onCancel: closeResetDialog,
      onConfirm: confirmReset,
      onClose: closeResetDialog,
      dialogRef: resetDialogRef,
    }),
  )
}

interface SubscriptionResetRequest {
  readonly enabled: boolean
  readonly onRequest: () => void
}

function SubscriptionPopover({ usage, providerName, t, nowMs, reset }: {
  readonly usage: CliSubscriptionUsage
  readonly providerName: string
  readonly t: CodingNsTranslator
  readonly nowMs: number
  readonly reset: SubscriptionResetRequest | null
}): ReactElement {
  if (usage.sub2api !== undefined) return createElement(Sub2ApiPopover, { usage: usage.sub2api, providerName, t })
  if (usage.deepseek !== undefined) return createElement(DeepseekPopover, { usage: usage.deepseek, providerName, t })
  if (usage.providerBalance !== undefined) {
    if (usage.provider?.capability === 'new-api') return createElement(NewApiPopover, { usage: usage.providerBalance, providerName, t })
    return createElement(ProviderBalancePopover, { usage: usage.providerBalance, providerName, t, nowMs })
  }
  const windows = [
    { id: 'primary', label: formatSubscriptionWindowLabel(usage.primary, t('usage.windowFiveHour'), t), window: usage.primary },
    { id: 'secondary', label: formatSubscriptionWindowLabel(usage.secondary, t('usage.windowWeekly'), t), window: usage.secondary },
    { id: 'monthly', label: formatSubscriptionWindowLabel(usage.monthly, t('usage.windowMonthly'), t), window: usage.monthly },
  ] as const
  const renderWindow = (key: string, label: string, window: CliSubscriptionWindow | null): ReactElement | null => window === null ? null
    : createElement('section', { key, style: windowStyle },
      createElement('div', { style: windowHeadingStyle }, createElement('span', undefined, label), createElement('span', undefined, `${formatPercent(window.remainingPercent)}%`)),
      createElement('div', { role: 'progressbar', 'aria-label': t('usage.windowRemaining', { label, percent: formatPercent(window.remainingPercent) }), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': window.remainingPercent, style: barStyle },
        createElement('span', { style: { ...barFillStyle, width: `${window.remainingPercent}%` } }),
      ),
      window.resetsAt !== null && createElement('div', { style: resetStyle }, t('usage.resetsIn', { time: formatCountdown(window.resetsAt, t) })),
    )
  // 上游按模型分组给额度（Antigravity 的 Gemini 组与 Claude/GPT 组各自有 5 小时与周窗口）。
  // 有分组时按组渲染完整明细，`primary`/`secondary` 只负责底部入口的单一进度。
  const quotaGroups = usage.groups ?? []
  const windowSections = quotaGroups.length > 0
    ? quotaGroups.flatMap((group) => [
        createElement('div', { key: `group:${group.id}`, style: quotaGroupTitleStyle }, formatSubscriptionGroupLabel(group, t)),
        ...group.windows.map((entry) => renderWindow(
          `group:${group.id}:${entry.kind}:${entry.label ?? ''}`,
          formatSubscriptionGroupWindowLabel(entry, t),
          entry.window,
        )),
      ])
    : windows.map(({ id, label, window }) => renderWindow(id, label, window))
  const credits = usage.credits ?? null
  const creditText = credits === null
    ? null
    : credits.unlimited
      ? t('usage.creditUnlimited')
      : credits.balance !== null
        ? formatCreditBalance(credits.balance)
        : credits.hasCredits ? '0.00' : '--'
  const expiries = usage.resetCredits === null
    ? []
    : usage.resetCredits.credits
      .map((credit) => credit.expiresAt)
      .filter((expiry): expiry is number => expiry !== null)
      .sort((left, right) => left - right)
  const accountName = usage.accountName?.trim() || null
  const planLabel = usage.planType === null ? null : formatPlanType(usage.planType)
  const paidPlanLabel = usage.paidPlanType?.trim() || null
  // 生效档位与账号持有的付费档位不一致时必须两个都显示：否则界面会把
  // “后端还没把 Pro 额度给到这个 Agent”显示成“账号没有订阅”。
  const planText = planLabel === null
    ? paidPlanLabel
    : paidPlanLabel === null || paidPlanLabel === planLabel
      ? planLabel
      : `${planLabel} · ${paidPlanLabel}`
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.popoverSubscriptionUsage', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('div', { style: popoverHeadingTextStyle },
        createElement('strong', undefined, t('usage.popoverSubscriptionTitle', { provider: providerName })),
        // 账号名来自上游可确认的登录标识；拿不到时整行不渲染。
        accountName !== null && createElement('span', { style: accountMetaStyle }, accountName),
      ),
      planText !== null && createElement('span', { style: { color: dshThemeColor.labelTertiary } }, planText),
    ),
    ...windowSections,
    (creditText !== null || usage.resetCredits !== null) && createElement('section', { style: resetCreditsSectionStyle },
      creditText !== null && createElement('div', { style: resetCreditsRowStyle },
        createElement('span', undefined, t('usage.creditBalanceLabel')),
        createElement('span', { style: resetCreditsValueStyle }, creditText),
      ),
      usage.resetCredits !== null && createElement('div', { style: resetCreditsRowStyle },
        createElement('span', undefined, t('usage.resetCreditsLabel')),
        createElement('span', { style: resetCreditsValueGroupStyle },
          createElement('span', { style: resetCreditsValueStyle }, t('usage.resetCreditsCount', { count: usage.resetCredits.availableCount })),
          reset !== null && createElement('button', {
            type: 'button',
            className: 'codingns4dsh-subscription-reset',
            disabled: !reset.enabled,
            onClick: reset.onRequest,
            title: reset.enabled ? t('usage.resetTooltipReady') : t('usage.resetTooltipNone'),
            'aria-label': t('usage.resetButton'),
          }, createElement(ResetIcon, undefined)),
        ),
      ),
      expiries.slice(0, 3).map((expiry, index) => createElement('div', { key: `${expiry}-${index}`, style: resetCreditsExpiryStyle },
        t('usage.resetCreditsExpiresAt', { time: formatResetExpiry(expiry, t, nowMs) }),
      )),
      expiries.length > 3 && createElement('div', { style: resetCreditsExpiryStyle }, t('usage.resetCreditsMore', { count: expiries.length - 3 })),
    ),
  )
}

/** 重置按钮复用会话变更视图的刷新字形，保持插件内图标语言一致。 */
function ResetIcon(): ReactElement {
  return createElement('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M16 8.5A6.2 6.2 0 1 0 16.1 12', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
    createElement('path', { d: 'M16 4.5v4h-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

function ResetConfirmDialog({ count, pending, result, error, t, onCancel, onConfirm, onClose, dialogRef }: {
  readonly count: number
  readonly pending: boolean
  readonly result: CliSubscriptionResetOutcome | null
  readonly error: string | null
  readonly t: CodingNsTranslator
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly onClose: () => void
  readonly dialogRef: RefObject<HTMLDivElement>
}): ReactElement {
  const finished = result !== null || error !== null
  const message = pending
    ? t('usage.resetDialogPending')
    : result !== null
      ? resetOutcomeMessage(result, t)
      : error !== null && error.trim() !== ''
        ? error
        : t('usage.resetDialogBody', { count })
  const messageColor = error !== null
    ? dshThemeColor.error
    : result === 'reset' || result === 'alreadyRedeemed' ? dshThemeColor.success : dshThemeColor.labelTertiary
  return createElement('div', { className: 'codingns4dsh-subscription-reset-overlay', role: 'presentation', style: resetDialogOverlayStyle },
    createElement('div', {
      ref: dialogRef,
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('usage.resetDialogTitle'),
      style: resetDialogStyle,
    },
      createElement('div', { style: { display: 'grid', gap: 4 } },
        createElement('strong', { style: { fontSize: 14, lineHeight: 1.4 } }, t('usage.resetDialogTitle')),
        createElement('span', { style: { color: messageColor, fontSize: 12, lineHeight: '18px' } }, message),
      ),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 } },
        finished
          ? createElement('button', { type: 'button', onClick: onClose, style: dshSettingsPrimaryButtonStyle }, t('usage.resetDialogClose'))
          : createElement('button', { type: 'button', disabled: pending, onClick: onCancel, style: dshSettingsButtonStyle, autoFocus: true }, t('usage.resetDialogCancel')),
        !finished && createElement('button', { type: 'button', disabled: pending, onClick: onConfirm, style: dshSettingsPrimaryButtonStyle }, t('usage.resetDialogConfirm')),
      ),
    ),
  )
}

function resetOutcomeMessage(outcome: CliSubscriptionResetOutcome, t: CodingNsTranslator): string {
  switch (outcome) {
    case 'reset': return t('usage.resetOutcomeReset')
    case 'alreadyRedeemed': return t('usage.resetOutcomeAlreadyRedeemed')
    case 'nothingToReset': return t('usage.resetOutcomeNothingToReset')
    case 'noCredit': return t('usage.resetOutcomeNoCredit')
  }
}

/** 根据服务端返回的窗口时长生成准确的额度标签，避免把七天窗口误显示成五小时。 */
function formatSubscriptionWindowLabel(window: CliSubscriptionWindow | null, fallback: string, t: CodingNsTranslator): string {
  const durationMins = window?.windowDurationMins
  if (durationMins === null || durationMins === undefined || !Number.isFinite(durationMins) || durationMins <= 0) return fallback
  if (durationMins % (24 * 60) === 0) return t('usage.windowDays', { count: durationMins / (24 * 60) })
  if (durationMins % 60 === 0) return t('usage.windowHours', { count: durationMins / 60 })
  return t('usage.windowMinutes', { count: durationMins })
}

/** 上游分组名本地化：只有已知分组用词条，其余原样显示上游名称。 */
function formatSubscriptionGroupLabel(group: CliSubscriptionGroup, t: CodingNsTranslator): string {
  if (group.id === 'gemini') return t('usage.quotaGroupGemini')
  if (group.id === 'third-party') return t('usage.quotaGroupThirdParty')
  return group.displayName
}

/** 窗口文案按类型取词条，未知类型回退到上游标签。 */
function formatSubscriptionGroupWindowLabel(entry: CliSubscriptionGroupWindow, t: CodingNsTranslator): string {
  if (entry.kind === 'five-hour') return t('usage.windowFiveHour')
  if (entry.kind === 'weekly') return t('usage.windowWeekly')
  if (entry.kind === 'monthly') return t('usage.windowMonthly')
  return entry.label ?? ''
}

/**
 * New-API 的普通 Key 没有 Sub2API 那种统一的完整统计对象。
 * 这里只投影读取器明确拿到的真实数值，隐藏内部 quota、Key 状态和占位文本，
 * 并把日志返回的模型/日期汇总拆成短表格，避免一整串文本撑坏弹层。
 */
function NewApiPopover({ usage, providerName, t }: { readonly usage: ProviderBalanceUsage; readonly providerName: string; readonly t: CodingNsTranslator }): ReactElement {
  const labels = NEW_API_DETAIL_LABELS
  const details = usage.details.filter((item) => isNewApiDisplayValue(item.value))
  const find = (...labels: string[]): string | number | null => {
    for (const label of labels) {
      const item = details.find((candidate) => candidate.label === label)
      if (item !== undefined) return item.value
    }
    return null
  }
  const stats: { readonly label: string; readonly value: string }[] = []
  const remaining = resolveNewApiRemaining(usage, details)
  if (remaining !== null) stats.push({ label: t('usage.newApiBalance'), value: formatNewApiBalanceAmount(remaining, usage.unit) })
  // Token 接口的 total_used 是内部 quota，即使 unit 写成 TOKENS 也不把它
  // 当作真实 Token；只有日志明确聚合出的 Token 才能展示。
  const todayTokens = find(labels.todayTokensLogs)
  if (todayTokens !== null) stats.push({ label: t('usage.statTodayTokens'), value: formatNewApiMetric(todayTokens, usage.unit, true) })
  const totalTokens = find(labels.totalTokensLogs)
  if (totalTokens !== null) stats.push({ label: t('usage.statTotalTokens'), value: formatNewApiMetric(totalTokens, usage.unit, true) })
  const feeUnit = resolveNewApiFeeUnit(usage, details, labels)
  const todayCost = find(labels.todayCost)
  if (todayCost !== null && feeUnit !== null) stats.push({ label: t('usage.statTodayCost'), value: formatNewApiMetric(todayCost, feeUnit, false) })
  const totalCost = find(labels.totalCost)
  if (totalCost !== null && feeUnit !== null) stats.push({ label: t('usage.statTotalCost'), value: formatNewApiMetric(totalCost, feeUnit, false) })
  const cacheHitRate = find(labels.cacheHitRateLogs)
  if (cacheHitRate !== null) stats.push({ label: t('usage.statTotalCacheHitRate'), value: String(cacheHitRate) })
  const models = parseNewApiStats(find(labels.modelsLogs))
  const daily = parseNewApiStats(find(labels.dailyLogs))
  const headline = formatNewApiHeadline(usage, details)
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.upstreamUsageTitle', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('strong', undefined, t('usage.upstreamUsageTitle', { provider: providerName })),
      headline !== null && createElement('span', { style: { color: dshThemeColor.labelTertiary } }, headline),
    ),
    stats.length > 0 && createElement('div', { style: sub2apiStatsGridStyle }, ...stats.map((stat) => createSub2ApiStat(stat.label, stat.value))),
    models.length > 0 && createNewApiStatsTable(t('usage.byModel'), models, t('usage.colModel'), t('usage.colRequests'), t('usage.colToken')),
    daily.length > 0 && createNewApiStatsTable(t('usage.byDay'), daily, t('usage.colDate'), t('usage.colRequests'), t('usage.colToken')),
  )
}

const NEW_API_DETAIL_LABELS = {
  todayTokensLogs: `${String.fromCodePoint(0x4eca, 0x65e5)} Token${String.fromCodePoint(0xff08, 0x6700, 0x8fd1, 0x65e5, 0x5fd7, 0xff09)}`,
  totalTokensLogs: `${String.fromCodePoint(0x7d2f, 0x8ba1)} Token${String.fromCodePoint(0xff08, 0x6700, 0x8fd1, 0x65e5, 0x5fd7, 0xff09)}`,
  todayCost: String.fromCodePoint(0x4eca, 0x65e5, 0x8d39, 0x7528),
  totalCost: String.fromCodePoint(0x7d2f, 0x8ba1, 0x8d39, 0x7528),
  cacheHitRateLogs: `${String.fromCodePoint(0x7f13, 0x5b58, 0x547d, 0x4e2d, 0x7387)}${String.fromCodePoint(0xff08, 0x6700, 0x8fd1, 0x65e5, 0x5fd7, 0xff09)}`,
  modelsLogs: `${String.fromCodePoint(0x6309, 0x6a21, 0x578b, 0x7edf, 0x8ba1)}${String.fromCodePoint(0xff08, 0x6700, 0x8fd1, 0x65e5, 0x5fd7, 0xff09)}`,
  dailyLogs: `${String.fromCodePoint(0x6309, 0x65e5, 0x7edf, 0x8ba1)}${String.fromCodePoint(0xff08, 0x6700, 0x8fd1, 0x65e5, 0x5fd7, 0xff09)}`,
  remainingBalance: String.fromCodePoint(0x4f59, 0x989d, 0x2f, 0x5269, 0x4f59, 0x989d, 0x5ea6),
  unavailable: String.fromCodePoint(0x4e0a, 0x6e38, 0x672a, 0x63d0, 0x4f9b),
  unknownUnit: String.fromCodePoint(0x4e0a, 0x6e38, 0x5355, 0x4f4d, 0x672a, 0x660e, 0x786e),
  upstreamUnit: String.fromCodePoint(0x4e0a, 0x6e38, 0x5355, 0x4f4d),
  delimiter: String.fromCodePoint(0xff1b),
} as const

function resolveNewApiFeeUnit(usage: ProviderBalanceUsage, details: readonly ProviderBalanceUsage['details'][number][], labels: typeof NEW_API_DETAIL_LABELS): string | null {
  if (usage.currency?.trim().toUpperCase() === 'USD') return 'USD'
  const declared = details.find((item) => item.label === labels.upstreamUnit)
  return typeof declared?.value === 'string' && declared.value.trim().toUpperCase() === 'USD' ? 'USD' : null
}

function isNewApiDisplayValue(value: string | number): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  const normalized = value.trim()
  return normalized !== '' && normalized !== '--' && normalized !== NEW_API_DETAIL_LABELS.unavailable && normalized !== NEW_API_DETAIL_LABELS.unknownUnit
}

function formatNewApiMetric(value: string | number, unit: string | null, token: boolean): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  if (token) return formatCompactTokenCount(numeric)
  return formatProviderBalanceAmount(numeric, unit)
}

function formatNewApiHeadline(usage: ProviderBalanceUsage, details: readonly ProviderBalanceUsage['details'][number][] = usage.details): string | null {
  // New-API 可能同时返回 unlimited_quota=true 与明确的 remaining。这里只
  // 显示明确余额；令牌额度标记不是账户余额，不能投影成“无限额度”。
  const remaining = resolveNewApiRemaining(usage, details)
  if (remaining !== null && Number.isFinite(remaining)) return formatNewApiBalanceValue(remaining, usage.unit)
  return null
}

function resolveNewApiRemaining(usage: ProviderBalanceUsage, details: readonly ProviderBalanceUsage['details'][number][]): number | null {
  if (usage.remaining !== null && Number.isFinite(usage.remaining)) return usage.remaining
  const detail = details.find((item) => item.label === NEW_API_DETAIL_LABELS.remainingBalance)
  return typeof detail?.value === 'number' && Number.isFinite(detail.value) ? detail.value : null
}

function formatNewApiBalanceValue(value: number, unit: string | null): string {
  const normalized = unit?.trim().toUpperCase() ?? ''
  if (normalized === '') return formatNewApiDecimal(value)
  if (normalized !== 'USD') return formatProviderBalanceValue(value, unit)
  return `$${formatNewApiDecimal(value)}`
}

function formatNewApiBalanceAmount(value: number, unit: string | null): string {
  const normalized = unit?.trim().toUpperCase() ?? ''
  if (normalized === '') return formatNewApiDecimal(value)
  if (normalized !== 'USD') return formatProviderBalanceAmount(value, unit)
  return `$${formatNewApiDecimal(value)}`
}

function formatNewApiDecimal(value: number): string {
  if (!Number.isFinite(value)) return '--'
  if (value === 0) return '0.00'
  if (Math.abs(value) >= 0.01) return value.toFixed(2)
  const precision = 6
  return value.toFixed(precision).replace(/0+$/u, '').replace(/\.$/u, '')
}

interface NewApiStatsRow { readonly name: string; readonly tokens: string; readonly requests: string }

function parseNewApiStats(value: string | number | null): NewApiStatsRow[] {
  if (typeof value !== 'string') return []
  return value.split(NEW_API_DETAIL_LABELS.delimiter).flatMap((part) => {
    const match = /^\s*(.+?):\s*([\d,.]+(?:[KMB])?)\s*Token\s*\/\s*([\d,]+)\s*次\s*$/u.exec(part)
    if (match === null) return []
    return [{ name: match[1]!.trim(), tokens: match[2]!, requests: match[3]! }]
  })
}

function createNewApiStatsTable(title: string, rows: readonly NewApiStatsRow[], nameLabel: string, requestsLabel: string, tokensLabel: string): ReactElement {
  return createElement('section', { style: sub2apiSectionStyle },
    createElement('strong', { style: sub2apiSectionTitleStyle }, title),
    createElement('div', { style: sub2apiTableScrollStyle },
      createElement('table', { style: sub2apiTableStyle },
        createElement('thead', undefined, createElement('tr', undefined,
          createElement('th', { style: sub2apiThStyle }, nameLabel),
          createElement('th', { style: sub2apiThStyle }, requestsLabel),
          createElement('th', { style: sub2apiThStyle }, tokensLabel),
        )),
        createElement('tbody', undefined, ...rows.map((row) => createElement('tr', { key: `${row.name}-${row.requests}` },
          createElement('td', { style: sub2apiTdStyle }, row.name),
          createElement('td', { style: sub2apiTdStyle }, row.requests),
          createElement('td', { style: sub2apiTdStyle }, row.tokens),
        ))),
      ),
    ),
  )
}

function ProviderBalancePopover({ usage, providerName, t, nowMs }: { readonly usage: ProviderBalanceUsage; readonly providerName: string; readonly t: CodingNsTranslator; readonly nowMs: number }): ReactElement {
  const models = summarizeProviderBalance(usage)
  const overallPercent = balancePercent(usage.remaining, usage.total)
  const details = usage.details.filter((item) => !isProviderModelDetail(item.label))
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.officialRemainingPopover', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('span', { style: providerBalanceHeadingStyle },
        createElement('strong', undefined, providerName),
        usage.planName?.trim() && createElement('span', { style: providerBalancePlanStyle }, usage.planName.trim()),
      ),
      createElement('span', { style: { color: dshThemeColor.labelTertiary } }, formatProviderBalance(usage, t('usage.upstreamNotProvided'))),
    ),
    overallPercent !== null && usage.remaining !== null && usage.total !== null && createElement(BalanceProgress, {
      label: t('usage.officialRemainingPopover', { provider: providerName }),
      percent: overallPercent,
      value: `${formatProviderBalanceAmount(usage.remaining, usage.unit)} / ${formatProviderBalanceAmount(usage.total, usage.unit)}`,
      style: overallBalanceStyle,
    }),
    usage.used !== null && createElement('div', { style: balanceMetaStyle }, t('usage.usedShort', { amount: formatProviderBalanceAmount(usage.used, usage.unit) })),
    createElement('section', { style: providerDetailsSectionStyle },
      createElement('strong', { style: providerBalanceSectionTitleStyle }, t('usage.providerDetails')),
      details.length === 0
        ? createElement('div', { style: resetStyle }, t('usage.upstreamNotProvided'))
        : details.map((item, index) => createElement('div', { key: `${item.label}-${index}`, style: providerDetailRowStyle },
          createElement('span', undefined, item.label),
          createElement('span', { style: providerDetailValueStyle }, formatProviderDetailValue(item.value, t)),
        )),
    ),
    models.length === 0
      ? createElement('div', { style: resetStyle }, t('usage.noMoreStats'))
      : models.map((model) => createElement('section', { key: model.name, style: providerBalanceModelStyle },
        createElement('div', { style: windowHeadingStyle },
          createElement('span', undefined, model.name),
          createElement('span', undefined, model.total === null ? formatProviderBalanceAmount(model.remaining ?? 0, usage.unit) : `${formatProviderBalanceAmount(model.remaining ?? 0, usage.unit)} / ${formatProviderBalanceAmount(model.total, usage.unit)}`),
        ),
        model.total !== null && model.remaining !== null && createElement(BalanceProgress, {
          label: model.name,
          percent: balancePercent(model.remaining, model.total) ?? 0,
          value: '',
        }),
        createElement('div', { style: balanceMetaStyle },
          model.used === null ? null : createElement('span', undefined, t('usage.usedShort', { amount: formatProviderBalanceAmount(model.used, usage.unit) })),
          model.periodEnd === null ? null : createElement('span', undefined, t('usage.expiresIn', { time: formatExpiryCountdown(model.periodEnd, t, nowMs) })),
        ),
      )),
  )
}

function BalanceProgress({ label, percent, value, style }: { readonly label: string; readonly percent: number; readonly value: string; readonly style?: Record<string, string | number> }): ReactElement {
  const normalized = Math.max(0, Math.min(100, percent))
  return createElement('div', { style: style ?? providerBalanceProgressStyle },
    createElement('div', { style: balanceProgressHeaderStyle },
      createElement('span', { style: visuallyHiddenStyle }, label),
      value !== '' && createElement('span', { style: balanceProgressValueStyle }, value),
      createElement('span', { style: balanceProgressPercentStyle }, `${Math.round(normalized)}%`),
    ),
    createElement('div', { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': normalized, style: providerBalanceBarStyle },
      createElement('span', { style: { ...providerBalanceBarFillStyle, width: `${normalized}%` } }),
    ),
  )
}

interface ProviderBalanceModel {
  readonly name: string
  remaining: number | null
  used: number | null
  total: number | null
  periodEnd: string | null
}

function summarizeProviderBalance(usage: ProviderBalanceUsage): ProviderBalanceModel[] {
  const models = new Map<string, ProviderBalanceModel>()
  for (const item of usage.details) {
    const label = item.label.trim()
    const matched = PROVIDER_DETAIL_SUFFIXES.find(({ suffix }) => label.endsWith(` ${suffix}`))
    if (matched === undefined) continue
    const name = label.slice(0, -(matched.suffix.length + 1)).trim()
    if (name === '') continue
    const model = models.get(name) ?? { name, remaining: null, used: null, total: null, periodEnd: null }
    if (matched.kind === 'remaining') model.remaining = typeof item.value === 'number' ? item.value : null
    else if (matched.kind === 'used') model.used = typeof item.value === 'number' ? item.value : null
    else if (matched.kind === 'total') model.total = typeof item.value === 'number' ? item.value : null
    else model.periodEnd = typeof item.value === 'string' ? item.value : null
    models.set(name, model)
  }
  return [...models.values()]
}

function isProviderModelDetail(label: string): boolean {
  const normalized = label.trim()
  return PROVIDER_DETAIL_SUFFIXES.some(({ suffix }) => normalized.endsWith(` ${suffix}`))
}

function formatProviderDetailValue(value: string | number, t: CodingNsTranslator): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : t('usage.upstreamNotProvided')
  const normalized = value.trim()
  return normalized === '' || normalized === '--' ? t('usage.upstreamNotProvided') : normalized
}

const PROVIDER_DETAIL_SUFFIXES = [
  { suffix: String.fromCodePoint(0x5269, 0x4f59), kind: 'remaining' },
  { suffix: String.fromCodePoint(0x5df2, 0x7528), kind: 'used' },
  { suffix: String.fromCodePoint(0x603b, 0x91cf), kind: 'total' },
  { suffix: String.fromCodePoint(0x5468, 0x671f, 0x7ed3, 0x675f), kind: 'periodEnd' },
  { suffix: 'remaining', kind: 'remaining' },
  { suffix: 'used', kind: 'used' },
  { suffix: 'total', kind: 'total' },
  { suffix: 'period end', kind: 'periodEnd' },
] as const

function balancePercent(remaining: number | null, total: number | null): number | null {
  if (remaining === null || total === null || !Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, remaining / total * 100))
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
/** 已具备用量读取契约的适配器才挂载底部订阅入口。 */
function isSubscriptionAdapter(adapterId: unknown): adapterId is 'antigravity' | 'command-code' | 'codex' | 'claude-code' | 'codebuddy' | 'codebuddy-cn' | 'dsh' | 'grok' | 'kimi' | 'opencode' | 'qoder' | 'qoder-cn' | 'workbuddy' | 'zcode' {
  return adapterId === 'antigravity' || adapterId === 'command-code' || adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'codebuddy' || adapterId === 'codebuddy-cn' || adapterId === 'dsh' || adapterId === 'grok' || adapterId === 'kimi' || adapterId === 'opencode' || adapterId === 'qoder' || adapterId === 'qoder-cn' || adapterId === 'workbuddy' || adapterId === 'zcode'
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
    case 'qoder': return 'Qoder'
    case 'qoder-cn': return 'Qoder CN'
    case 'zcode': return 'ZCode'
    case 'codebuddy': return 'CodeBuddy'
    case 'codebuddy-cn': return 'CodeBuddy'
    case 'workbuddy': return 'WorkBuddy'
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
function formatProviderBalance(usage: ProviderBalanceUsage | undefined, unavailable = '--'): string {
  if (usage === undefined || usage.remaining === null) return unavailable
  return formatProviderBalanceValue(usage.remaining, usage.unit)
}
function formatProviderBalanceValue(value: number, unit: string | null): string {
  const normalized = unit?.trim().toUpperCase() ?? ''
  const amount = formatProviderBalanceAmount(value, unit)
  if (normalized === '%' || normalized === 'USD') return amount
  return `${amount}${normalized === '' ? '' : ` ${normalized}`}`
}
function formatProviderBalanceAmount(value: number, unit: string | null): string {
  const normalized = unit?.trim().toUpperCase() ?? ''
  if (normalized === '%') return `${value.toFixed(0)}%`
  // 小于 0.01 的非零余额不能被固定两位小数舍成 $0.00；复用
  // New-API 的金额格式化规则，正常金额保留两位，小额保留非零有效位。
  if (normalized === 'USD') return `$${formatNewApiDecimal(value)}`
  return isTokenUnit(normalized) ? formatCompactTokenCount(value) : value.toFixed(2)
}
function formatSub2ApiTokens(value: number): string { return formatCompactTokenCount(value) }
function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '--'
  const absolute = Math.abs(value)
  const format = (divisor: number, suffix: string): string => {
    const amount = value / divisor
    const rounded = Math.round(amount * 10) / 10
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`
  }
  if (absolute >= 1_000_000_000) return format(1_000_000_000, 'B')
  if (absolute >= 1_000_000) return format(1_000_000, 'M')
  if (absolute >= 1_000) return format(1_000, 'K')
  return String(Math.round(value))
}
function isTokenUnit(unit: string): boolean { return /^(?:TOKENS?|TOKEN_COUNT)$/u.test(unit) }
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
function formatExpiryCountdown(value: string, t: CodingNsTranslator, nowMs: number): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  if (timestamp <= nowMs) return t('usage.expired')
  return formatCountdown(timestamp / 1000, t, nowMs) ?? t('usage.expired')
}
function formatResetExpiry(expiry: number, t: CodingNsTranslator, nowMs: number): string {
  if (expiry * 1000 <= nowMs) return t('usage.resetCreditsExpired')
  return formatCountdown(expiry, t, nowMs) ?? t('usage.resetCreditsExpired')
}

/** 点数余额保留两位小数展示；无法解析时原样保留上游字符串。 */
function formatCreditBalance(value: string): string {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(2) : value
}

const subscriptionRootStyle = { position: 'relative' as const, minWidth: 0, display: 'inline-flex', alignItems: 'center' }
const subscriptionTriggerStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, border: 0, borderRadius: 14, padding: '0 8px 0 4px', color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: 13, lineHeight: '20px' }
const subscriptionLabelStyle = { whiteSpace: 'nowrap' as const }
const sub2apiIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' }
const sub2apiLogoStyle = { display: 'block', borderRadius: 4, objectFit: 'contain' as const }
const deepseekBalanceIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const }
const deepseekLogoStyle = { display: 'block', borderRadius: 5, objectFit: 'contain' as const }
const deepseekBalanceStyle = { display: 'inline-flex', alignItems: 'center', color: dshThemeColor.labelSecondary, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const providerBalanceHeadingStyle = { display: 'grid', gap: 2, minWidth: 0 }
const providerBalancePlanStyle = { color: dshThemeColor.labelTertiary, fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const deepseekBalanceSectionStyle = { display: 'grid', gap: 6, marginTop: 10, padding: '10px 0 2px', borderTop: `1px solid ${dshThemeColor.border}` }
const deepseekBalanceDetailsStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: 12 }
const overallBalanceStyle = { display: 'grid', gap: 5, marginTop: 10 }
const providerDetailsSectionStyle = { display: 'grid', gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}` }
const providerBalanceSectionTitleStyle = { fontSize: 12, color: dshThemeColor.labelSecondary }
const providerDetailRowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: 12, lineHeight: '17px' }
const providerDetailValueStyle = { color: dshThemeColor.labelSecondary, textAlign: 'right' as const, overflowWrap: 'anywhere' as const }
const providerBalanceModelStyle = { display: 'grid', gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}` }
const providerBalanceProgressStyle = { display: 'grid', gap: 5, marginTop: 10 }
const balanceProgressHeaderStyle = { display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0, color: dshThemeColor.labelTertiary, fontSize: 11, fontVariantNumeric: 'tabular-nums' as const }
const balanceProgressValueStyle = { color: dshThemeColor.labelSecondary, fontWeight: 600 }
const balanceProgressPercentStyle = { color: dshThemeColor.labelTertiary, fontVariantNumeric: 'tabular-nums' as const }
const balanceMetaStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: 11, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' as const }
const visuallyHiddenStyle = { position: 'absolute' as const, width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden' as const, clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap' as const, border: 0 }
const providerBalanceBarStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const providerBalanceBarFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const deepseekUnavailableStatsStyle = { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelTertiary, fontSize: 12, lineHeight: '17px' }
const progressRingVisualStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 2, borderRadius: 'inherit' }
const progressRingValueStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, borderRadius: 'inherit', background: dshThemeColor.menuBackground, fontSize: 7, lineHeight: 1, fontWeight: 700, color: dshThemeColor.labelPrimary, whiteSpace: 'nowrap' as const }
const progressRingSuffixStyle = { fontSize: 5.5, lineHeight: 1, color: dshThemeColor.labelTertiary, transform: 'translateY(1px)' }
const popoverHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}`, fontSize: 14 }
const popoverHeadingTextStyle = { display: 'grid', gap: 2, minWidth: 0 }
const accountMetaStyle = { overflow: 'hidden', color: dshThemeColor.labelTertiary, fontSize: 11, lineHeight: '16px', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const upstreamMetaStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingTop: 8, color: dshThemeColor.labelTertiary, fontSize: 11, lineHeight: '16px' }
const upstreamTypeStyle = { flex: '0 0 auto', color: dshThemeColor.labelSecondary, fontWeight: 600 }
const upstreamLinkStyle = { minWidth: 0, overflow: 'hidden', color: dshThemeColor.accent, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textDecoration: 'none' }
const upstreamMutedStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' as const }
const windowStyle = { display: 'grid', gap: 6, paddingTop: 10 }
const windowHeadingStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: 13 }
const barStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const barFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const resetStyle = { color: dshThemeColor.labelTertiary, fontSize: 12 }
const quotaGroupTitleStyle = { paddingTop: 12, color: dshThemeColor.labelSecondary, fontSize: 12, fontWeight: 600, letterSpacing: '.02em' }
const subscriptionPopoverStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1200, bottom: 'calc(100% + 8px)', left: 0, width: 'max-content', minWidth: 280, maxWidth: 'min(400px, calc(100vw - 24px))', boxSizing: 'border-box' as const, padding: 14, borderRadius: 12 }
const resetCreditsSectionStyle = { display: 'grid', gap: 6, marginTop: 10, padding: '10px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 10, background: dshThemeColor.surfaceSubtle }
const resetCreditsRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: 13 }
const resetCreditsValueGroupStyle = { display: 'inline-flex', alignItems: 'center', gap: 8 }
const resetCreditsValueStyle = { color: dshThemeColor.labelPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const resetCreditsExpiryStyle = { color: dshThemeColor.labelTertiary, fontSize: 11, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' as const }
const resetDialogOverlayStyle = { position: 'fixed' as const, inset: 0, zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' as const, background: dshThemeColor.overlay }
const resetDialogStyle = { ...dshPopupSurfaceStyle, width: 'min(100%, 420px)', boxSizing: 'border-box' as const, padding: 16, borderRadius: 12, display: 'grid', gap: 12 }
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
function createRemainingRing(percent: number): ReactElement {
  return createElement('span', { 'aria-hidden': true, style: progressRingStyle() },
    createElement('span', { style: { ...progressRingVisualStyle, background: progressRingVisualBackground(percent / 100, false) } },
      createElement('span', { style: progressRingValueStyle },
        createElement('span', undefined, formatRingPercentage(percent)),
        createElement('span', { style: progressRingSuffixStyle }, '%'),
      ),
    ),
  )
}

export { CommandCodeSubscriptionSlot }
export const registerCommandCodeSubscriptionSlot = registerSubscriptionSlot

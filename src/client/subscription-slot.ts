import { startSerialPolling } from './serial-polling.js'
import { createElement, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { isSubscriptionUsageFresh } from '../shared/contracts/subscription.js'
import type { CliSubscriptionGroup, CliSubscriptionGroupWindow, CliSubscriptionResetOutcome, CliSubscriptionResetResult, CliSubscriptionSnapshot, CliSubscriptionUsage, CliSubscriptionWindow, DeepseekUsage, MagpieQuota, MagpieQuotaWindow, MagpieUsageSnapshot, ProviderBalanceUsage, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../shared/contracts/subscription.js'
import type { MagpieUsageRequestPage } from '../shared/contracts/magpie-management.js'
import { DEFAULT_SUBSCRIPTION_USAGE_SETTINGS } from '../shared/contracts/config.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { providerIconUrl } from './provider-icons.js'
import { MagpieProviderLogo } from './features/magpie-provider-logo.js'
import { MAGPIE_REQUESTS_PAGE_SIZE, RequestsPage, installMagpiePageStyles } from './features/magpie-management-page.js'
import {
  createQuotaAccountBlock,
  createQuotaGroupHeader,
  formatQuotaCredits,
  formatQuotaNumber,
  groupQuotasByProvider,
  readWindowCreditBalance,
  resolveQuotaBalanceLabel,
  resolveQuotaCreditBalance,
} from './features/subscription-quota-groups.js'
import { subscribeSessionAdapters } from './session-adapter-cache.js'
import { loadCliSessionConfig } from './cli-session-config-cache.js'
import { dshPopupSurfaceStyle, dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from './theme.js'
import { backdropPointerDownHandler, useDismissOnOutsidePointer } from './popup-dismiss.js'
import { callCodingNsRpcResult } from './rpc-call.js'
import type { SessionSnapshot } from './cli-slots.js'
import { uiFontSize } from './font-scale.js'

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
type UsageCache = Map<string, { readonly usage: CliSubscriptionSnapshot; readonly capturedAt: number }>
const usageCaches = new WeakMap<CodingNsRpcClient, UsageCache>()
const usageLoads = new WeakMap<CodingNsRpcClient, Map<string, Promise<CliSubscriptionSnapshot | null>>>()
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

function loadUsage(rpc: CodingNsRpcClient, key: string, payload: unknown): Promise<CliSubscriptionSnapshot | null> {
  let loads = usageLoads.get(rpc)
  if (loads === undefined) { loads = new Map(); usageLoads.set(rpc, loads) }
  const existing = loads.get(key)
  if (existing !== undefined) return existing
  const request = callCliRpc<unknown>(rpc, 'subscription', payload, AbortSignal.timeout(30_000))
    .then(normalizeSubscriptionSnapshot)
    .finally(() => { if (loads.get(key) === request) loads.delete(key) })
  loads.set(key, request)
  return request
}

/** 图标重置按钮的悬停/按下/聚焦/禁用只能由注入样式表表达，内联样式无法命中伪类。 */
const RESET_BUTTON_CSS = '.codingns4dsh-subscription-reset{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer;transition:background .15s ease,color .15s ease}.codingns4dsh-subscription-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}.codingns4dsh-subscription-reset:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.14))}.codingns4dsh-subscription-reset:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1677ff))}.codingns4dsh-subscription-reset:disabled{opacity:.4;cursor:not-allowed}@media (prefers-reduced-motion: reduce){.codingns4dsh-subscription-reset{transition:none}}'
const MAGPIE_ROUTE_CSS = '@keyframes codingns4dsh-magpie-route-pulse{0%{transform:translateY(-120%);opacity:0}20%{opacity:1}80%{opacity:1}100%{transform:translateY(320%);opacity:0}}@keyframes codingns4dsh-magpie-route-breathe{0%,100%{box-shadow:0 0 0 0 rgba(22,119,255,0)}50%{box-shadow:0 0 0 4px rgba(22,119,255,.16)}}@keyframes codingns4dsh-magpie-route-step{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}.codingns4dsh-magpie-route-pulse{animation:codingns4dsh-magpie-route-pulse 1.8s ease-in-out infinite}.codingns4dsh-magpie-route-node-active{animation:codingns4dsh-magpie-route-breathe 2s ease-in-out infinite}.codingns4dsh-magpie-route-step{animation:codingns4dsh-magpie-route-step .38s cubic-bezier(.2,.75,.25,1) both;transition:background .16s ease}.codingns4dsh-magpie-route-step:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}.codingns4dsh-magpie-route-step:hover .codingns4dsh-magpie-route-node{box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#1677ff),0 0 0 4px rgba(22,119,255,.1)}.codingns4dsh-magpie-route-node{transition:box-shadow .16s ease}.codingns4dsh-magpie-tab:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1677ff)) inset}@media (prefers-reduced-motion:reduce){.codingns4dsh-magpie-route-pulse,.codingns4dsh-magpie-route-node-active,.codingns4dsh-magpie-route-step,.codingns4dsh-magpie-route-node{animation:none;transition:none}}'

const MAGPIE_REQUESTS_CSS = '.codingns4dsh-magpie-route-requests:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}.codingns4dsh-magpie-route-requests:focus-visible,.codingns4dsh-magpie-requests-close:focus-visible,.codingns4dsh-magpie-requests-retry:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1677ff))}.codingns4dsh-magpie-requests-close:hover,.codingns4dsh-magpie-requests-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}.codingns4dsh-magpie-requests-dialog:focus,.codingns4dsh-magpie-requests-dialog:focus-visible{outline:none}.codingns4dsh-magpie-requests-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}.codingns4dsh-magpie-requests-view{display:block!important;width:100%;height:auto!important;min-height:0;padding-left:0!important;background:transparent}.codingns4dsh-magpie-requests-view .codingns-magpie-view{max-width:none;padding:0}@media (max-width:768px){.codingns4dsh-magpie-requests-overlay{align-items:flex-end!important;padding:12px!important}.codingns4dsh-magpie-requests-dialog{width:100%!important;max-height:78vh!important;max-height:78dvh!important}}@media (prefers-reduced-motion:reduce){.codingns4dsh-magpie-route-requests{transition:none}}'

export function calculateMagpiePopoverPlacement(rootLeft: number, viewportWidth: number, sidebarLeft: number | null): { readonly left: number; readonly width: number } {
  const margin = 12
  const boundary = Math.min(viewportWidth - margin, sidebarLeft === null ? viewportWidth - margin : sidebarLeft - margin)
  const width = Math.max(0, Math.min(400, boundary - margin))
  const left = Math.max(margin, Math.min(rootLeft, boundary - width))
  return { left: left - rootLeft, width }
}

/**
 * 移动端订阅入口只保留图标，完整数据仍可在点击后的弹层中查看。
 * 弹层高度上限固定为浏览器可视高度的 75%：先写 `vh` 兜底，再由 `dvh` 覆盖，
 * 使移动端工具栏收展后仍按真实可视区计算；超出部分在弹层内部纵向滚动。
 */
export const SUBSCRIPTION_RESPONSIVE_CSS = '@media (max-width: 768px){.codingns4dsh-subscription-trigger{gap:0!important;padding-left:4px!important;padding-right:4px!important}.codingns4dsh-subscription-label,.codingns4dsh-subscription-value{display:none!important}.codingns4dsh-subscription-popover{position:fixed!important;left:12px!important;right:12px!important;bottom:48px!important;width:auto!important;min-width:0!important;max-width:none!important;max-height:75vh!important;max-height:75dvh!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain!important;box-sizing:border-box!important}}'

function installSubscriptionStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${SUBSCRIPTION_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = SUBSCRIPTION_STYLE_ID
  style.textContent = SUBSCRIPTION_RESPONSIVE_CSS + RESET_BUTTON_CSS + MAGPIE_ROUTE_CSS + MAGPIE_REQUESTS_CSS
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
  const [snapshot, setSnapshot] = useState<CliSubscriptionSnapshot | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [eligible, setEligible] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [magpieTab, setMagpieTab] = useState<'usage' | 'route'>('usage')
  // 多账号厂商默认只展开会话实际使用的账号；展开状态挂在根组件上，
  // 弹层内容本身不持有 Hook，便于无浏览器的组件测试直接展开内容树。
  const [expandedQuotaGroups, setExpandedQuotaGroups] = useState<readonly string[]>([])
  const toggleQuotaGroup = (provider: string): void => {
    setExpandedQuotaGroups((current) => current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider])
  }
  const [magpiePlacement, setMagpiePlacement] = useState({ left: 0, width: 400 })
  const [clock, setClock] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const magpiePopoverRef = useRef<HTMLDivElement>(null)
  const resetDialogRef = useRef<HTMLDivElement>(null)
  // 重置成功后的刷新不能重跑加载 effect，否则 usage 会被清空导致底部入口闪断。
  const refreshRef = useRef<null | ((options?: { readonly afterPending?: boolean }) => Promise<void>)>(null)
  const routeRefreshControllerRef = useRef<AbortController | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [resetResult, setResetResult] = useState<CliSubscriptionResetOutcome | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  // Agent-native session bindings are written by Host during a turn. Refresh
  // at turn state changes so a snapshot loaded before the binding is not kept.
  const modelSelectionRevision = props.useSession?.((value) => JSON.stringify([value.modelSelection, value.running]))
  // Agent、模型或 Provider 切换可能只改变 Host 侧会话配置，DSH 会话快照不一定会更新；
  // 订阅适配器缓存的通知才能真正触发重新查询，否则底部会一直显示旧上游的数据。
  const [adapterRevision, bumpAdapterRevision] = useState(0)
  const openRef = useRef(open)
  openRef.current = open
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const hasMagpieSnapshot = snapshot?.magpie != null
  useEffect(() => subscribeSessionAdapters(() => { bumpAdapterRevision((value) => value + 1) }), [])

  useLayoutEffect(() => {
    if (!open || !hasMagpieSnapshot || typeof document === 'undefined' || typeof window === 'undefined') return
    const root = rootRef.current
    const popover = magpiePopoverRef.current
    if (root === null || popover === null) return

    const getOpenSidebar = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('[data-sidebar-right-session][data-sidebar-right-open]')]
      .find((element) => element.closest('[hidden]') === null && element.getBoundingClientRect().width > 0)
    let observedSidebar: HTMLElement | undefined
    let resizeObserver: ResizeObserver | undefined

    const updatePlacement = (): void => {
      const sidebar = getOpenSidebar()
      if (sidebar !== observedSidebar) {
        if (observedSidebar !== undefined) resizeObserver?.unobserve(observedSidebar)
        observedSidebar = sidebar
        if (observedSidebar !== undefined) resizeObserver?.observe(observedSidebar)
      }
      if (window.innerWidth <= 768) {
        setMagpiePlacement((current) => current.left === 0 && current.width === 400 ? current : { left: 0, width: 400 })
        return
      }
      const sidebarLeft = sidebar?.getBoundingClientRect().left ?? null
      const next = calculateMagpiePopoverPlacement(root.getBoundingClientRect().left, window.innerWidth, sidebarLeft)
      setMagpiePlacement((current) => current.left === next.left && current.width === next.width ? current : next)
    }

    resizeObserver = typeof globalThis.ResizeObserver === 'function' ? new globalThis.ResizeObserver(updatePlacement) : undefined
    resizeObserver?.observe(root)
    resizeObserver?.observe(popover)
    updatePlacement()
    const mutationObserver = typeof globalThis.MutationObserver === 'function' ? new globalThis.MutationObserver(updatePlacement) : undefined
    mutationObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar-right-open', 'hidden'], childList: true, subtree: true })
    window.addEventListener('resize', updatePlacement)
    document.addEventListener('scroll', updatePlacement, true)
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', updatePlacement)
      document.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open, hasMagpieSnapshot])

  useEffect(() => {
    const sessionId = props.sessionId?.trim()
    if (!sessionId) {
      setEligible(false)
      setSnapshot(null)
      setAdapterId(null)
      setProviderId(null)
      setOpen(false)
      setResetOpen(false)
      setResetPending(false)
      setResetResult(null)
      setResetError(null)
      setMagpieTab('usage')
      return
    }
    let active = true
    // 未解析的 Magpie 配额必须快速补读：官方余额一旦抢先显示，用户要等到下一次
    // 轮询（默认 5 分钟）或整页刷新才会切到 Magpie。
    let upstreamUnresolved = false
    setEligible(false)
    setSnapshot(null)
    setAdapterId(null)
    setProviderId(null)
    setOpen(false)
    setResetOpen(false)
    setResetPending(false)
    setResetResult(null)
    setResetError(null)
    setMagpieTab('usage')
    const refresh = async (signal: AbortSignal): Promise<boolean | void> => {
      let routeSignal: AbortSignal | undefined
      setLoading(true)
      try {
        // 订阅入口必须读取当前会话的真实 Provider；模型选择器切换后不能复用
        // 其它组件为减少 RPC 而保留的短期快照。
        const selection = await loadCliSessionConfig(props.rpc, sessionId, { force: true })
        const adapterId = selection.adapterId
        if (!active || !isSubscriptionAdapter(adapterId)) {
          if (active) {
            setEligible(false)
            setSnapshot(null)
            setAdapterId(null)
            setProviderId(null)
          }
          return
        }
        if (signal.aborted) return false
        if (active) {
          setEligible(true)
          setAdapterId(adapterId)
          setProviderId(selection.providerId ?? null)
        }
        const intervalMins = props.getRefreshIntervalMins?.() ?? DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins
        // 模型也是读取键的一部分：Antigravity 的 Gemini 与 Claude/GPT 是两个独立配额组。
        // 会话 ID 同时承担 PeerHost 的路由身份；缓存也必须按会话隔离，
        // 否则本机与远端使用相同 Agent/Provider/模型时会互相复用上游结果。
        const cacheKey = JSON.stringify([adapterId, selection.providerId ?? '', selection.modelId ?? '', sessionId, selection.providerSessionId ?? ''])
        const magpieSnapshot = snapshotRef.current?.magpie
        const includeRoute = magpieSnapshot !== null && magpieSnapshot !== undefined
          && (openRef.current || shouldResolveMagpieQuota(magpieSnapshot))
        const cached = subscriptionUsageCache.get(cacheKey)
        // New-API 的余额和 Token 日志可能随 Key/钱包状态快速变化，且旧结果
        // 容易把历史日志投影到当前站点；每次刷新都重新读取，Sub2API 仍复用原缓存。
        const canReuseCachedUsage = cached !== undefined && cached.usage.providerUsage?.provider?.capability !== 'new-api'
        if (!includeRoute && canReuseCachedUsage && isSubscriptionUsageFresh(cached.capturedAt, Date.now(), intervalMins)) {
          if (active) setSnapshot(cached.usage)
          return
        }
        const payload = {
          sessionId,
          adapterId,
          ...(selection.providerId ? { providerId: selection.providerId } : {}),
          ...(selection.modelId ? { modelId: selection.modelId } : {}),
          ...(includeRoute ? { includeRoute: true } : {}),
        }
        routeSignal = includeRoute ? routeRefreshControllerRef.current?.signal : undefined
        const requestSignal = routeSignal === undefined ? signal : AbortSignal.any([signal, routeSignal])
        const next = includeRoute
          ? normalizeSubscriptionSnapshot(await callCliRpc<unknown>(props.rpc, 'subscription', payload, requestSignal))
          : await loadUsage(props.rpc, cacheKey, payload)
        if (next !== null) subscriptionUsageCache.set(cacheKey, { usage: next, capturedAt: Date.now() })
        upstreamUnresolved = shouldResolveMagpieQuota(next?.magpie)
        if (active) setSnapshot(next)
      } catch {
        if (signal.aborted || routeSignal?.aborted === true) return false
        if (active) {
          setEligible(false)
          setSnapshot(null)
        }
        return false
      } finally {
        if (active) setLoading(false)
      }
    }
    const intervalMins = props.getRefreshIntervalMins?.() ?? DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins
    const pollIntervalMs = Math.max(0, intervalMins) * 60_000
    const poll = startSerialPolling(refresh, pollIntervalMs, {
      timeoutMs: 30_000,
      getIntervalMs: () => upstreamUnresolved ? Math.min(pollIntervalMs, MAGPIE_QUOTA_RETRY_MS) : pollIntervalMs,
    })
    refreshRef.current = poll.refresh
    return () => {
      active = false
      routeRefreshControllerRef.current?.abort()
      routeRefreshControllerRef.current = null
      refreshRef.current = null
      poll.dispose()
    }
  }, [props.rpc, props.sessionId, props.getRefreshIntervalMins, modelSelectionRevision, adapterRevision])

  // Route history is also required to resolve quotas for automatic models.
  // The serial poller owns timing; this controller bounds the extra read to
  // the panel lifetime or the period while the quota's upstream is unknown.
  const magpieQuotaNeedsResolution = shouldResolveMagpieQuota(snapshot?.magpie)
  const shouldLoadMagpieRoute = open || magpieQuotaNeedsResolution
  useEffect(() => {
    if (!shouldLoadMagpieRoute || !hasMagpieSnapshot) {
      routeRefreshControllerRef.current?.abort()
      routeRefreshControllerRef.current = null
      return
    }
    const controller = new AbortController()
    routeRefreshControllerRef.current = controller
    void refreshRef.current?.({ afterPending: true })
    return () => {
      controller.abort()
      if (routeRefreshControllerRef.current === controller) routeRefreshControllerRef.current = null
    }
  }, [shouldLoadMagpieRoute, hasMagpieSnapshot])

  useEffect(() => {
    if (!eligible || snapshot === null) return
    const timer = globalThis.setInterval(() => setClock(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [eligible, snapshot])

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
          sessionId: props.sessionId?.trim() ?? '',
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

  if (!eligible || snapshot === null) return null
  if (snapshot.magpie !== null) {
    const magpie = snapshot.magpie
    const readout = resolveMagpieTriggerReadout(magpie)
    const label = t('usage.magpieUsageLabel')
    return createElement('div', { ref: rootRef, style: subscriptionRootStyle },
      createElement('button', {
        type: 'button',
        className: 'codingns4dsh-subscription-trigger',
        onClick: () => setOpen((value) => !value),
        'aria-label': label,
        'aria-expanded': open,
        style: subscriptionTriggerStyle,
      },
        createElement('span', { style: magpieTriggerIconStyle, 'aria-hidden': true }, createElement('img', {
          src: providerIconUrl('magpie') ?? '/api/codingns/provider-icons/magpie.png',
          alt: '',
          width: 20,
          height: 20,
          style: magpieTriggerImageStyle,
        })),
        createMagpieTriggerReadout(readout, t),
      ),
      open && createElement(MagpieUsagePopover, {
        rpc: props.rpc,
        usage: magpie,
        t,
        tab: magpieTab,
        onTabChange: setMagpieTab,
        expandedGroups: expandedQuotaGroups,
        onToggleGroup: toggleQuotaGroup,
        placement: magpiePlacement,
        popoverRef: magpiePopoverRef,
      }),
    )
  }
  const usage = snapshot.providerUsage
  // 未拿到真实订阅数据时不占用底部栏空间；加载状态不能伪装成订阅存在。
  if (usage === null || (usage.sub2api === undefined && usage.deepseek === undefined && usage.providerBalance === undefined && resolveDisplayWindow(usage) === null)) return null
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
  const providerLogoSource = usage.provider?.logoDataUrl?.trim() || (!isRemoteWebContext() ? usage.provider?.logoUrl?.trim() : '') || providerIconUrl(usage.provider?.id ?? '') || adapterIconSource
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
          : sub2api !== undefined ? t('usage.todayCostShort', { amount: formatSub2ApiMoney(sub2api.today.cost, sub2api.unit) }) : deepseek !== undefined || providerBalance?.r4 !== undefined ? t('usage.accountBalance') : isNewApiProvider ? providerName : providerBalancePlan ?? t('usage.officialRemaining'),
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

function MagpieUsagePopover({ rpc, usage, t, tab = 'usage', onTabChange = () => {}, expandedGroups = [], onToggleGroup = () => {}, placement = { left: 0, width: 400 }, popoverRef }: {
  readonly rpc: CodingNsRpcClient
  readonly usage: MagpieUsageSnapshot
  readonly t: CodingNsTranslator
  readonly tab?: 'usage' | 'route'
  readonly onTabChange?: (tab: 'usage' | 'route') => void
  readonly expandedGroups?: readonly string[]
  readonly onToggleGroup?: (provider: string) => void
  readonly placement?: { readonly left: number; readonly width: number }
  readonly popoverRef?: RefObject<HTMLDivElement>
}): ReactElement {
  const aggregateRows = usage.aggregate === null ? [] : [
    [t('usage.magpieRequests'), formatMagpieNumber(usage.aggregate.calls)],
    [t('usage.magpieErrors'), formatMagpieNumber(usage.aggregate.errors)],
    [t('usage.magpieInputTokens'), formatMagpieTokenCount(usage.aggregate.inputTokens)],
    [t('usage.magpieOutputTokens'), formatMagpieTokenCount(usage.aggregate.outputTokens)],
    [t('usage.magpieCacheReadTokens'), formatMagpieTokenCount(usage.aggregate.cacheReadTokens)],
    [t('usage.magpieCacheWriteTokens'), formatMagpieTokenCount(usage.aggregate.cacheWriteTokens)],
    [t('usage.magpieTotalTokens'), formatMagpieTokenCount(sumKnownCounts(usage.aggregate.inputTokens, usage.aggregate.outputTokens))],
    [t('usage.magpieCacheHitRate'), formatMagpieCacheHitRate(usage.aggregate.inputTokens, usage.aggregate.cacheReadTokens)],
    [t('usage.magpieCost'), formatMagpieCost(usage.aggregate.costUsd)],
  ] as const
  const sessionRows = usage.session === null ? [] : [
    [t('usage.magpieRequests'), formatMagpieNumber(usage.session.calls)],
    [t('usage.magpieErrors'), formatMagpieNumber(usage.session.errors)],
    [t('usage.magpieInputTokens'), formatMagpieTokenCount(usage.session.inputTokens)],
    [t('usage.magpieOutputTokens'), formatMagpieTokenCount(usage.session.outputTokens)],
    [t('usage.magpieCacheReadTokens'), formatMagpieTokenCount(usage.session.cacheReadTokens)],
    [t('usage.magpieCacheWriteTokens'), formatMagpieTokenCount(usage.session.cacheWriteTokens)],
    [t('usage.magpieTotalTokens'), formatMagpieTokenCount(sumKnownCounts(usage.session.inputTokens, usage.session.outputTokens))],
    [t('usage.magpieCacheHitRate'), formatMagpieCacheHitRate(usage.session.inputTokens, usage.session.cacheReadTokens)],
    [t('usage.magpieCost'), formatMagpieCost(usage.session.costUsd)],
  ] as const
  const quotas = usage.quotas ?? []
  const tabs = [
    { id: 'usage' as const, label: t('usage.magpieTabUsage') },
    { id: 'route' as const, label: t('usage.magpieTabRoute') },
  ]
  return createElement('div', {
    ref: popoverRef,
    className: 'codingns4dsh-subscription-popover',
    role: 'dialog',
    'aria-label': t('usage.magpieUsageLabel'),
    style: { ...magpiePopoverStyle, left: placement.left, width: placement.width, maxWidth: placement.width },
  },
    createElement('div', { style: magpiePopoverHeadingStyle },
      createElement('div', { style: magpiePopoverHeadingTextStyle },
        createElement('strong', undefined, t('usage.magpieTitle')),
      ),
      createElement('span', { style: magpieHeaderMetaStyle },
        createElement('span', { style: magpieHeaderMutedStyle }, t('usage.magpieUpdated', { time: formatMagpieTimestamp(usage.capturedAt) })),
      ),
    ),
    createElement('div', { role: 'tablist', 'aria-label': t('usage.magpieUsageLabel'), style: magpieTabsStyle },
      ...tabs.map((entry) => createElement('button', {
        key: entry.id,
        type: 'button',
        role: 'tab',
        id: `codingns4dsh-magpie-tab-${entry.id}`,
        'aria-selected': tab === entry.id,
        'aria-controls': `codingns4dsh-magpie-panel-${entry.id}`,
        className: 'codingns4dsh-magpie-tab',
        onClick: () => onTabChange(entry.id),
        style: { ...magpieTabStyle, ...(tab === entry.id ? magpieTabActiveStyle : {}) },
      }, entry.label)),
    ),
    createElement('div', {
      role: 'tabpanel',
      id: `codingns4dsh-magpie-panel-${tab}`,
      'aria-labelledby': `codingns4dsh-magpie-tab-${tab}`,
      style: magpieTabPanelStyle,
    },
      tab === 'usage' ? MagpieUsagePanel({ usage, aggregateRows, sessionRows, t })
        : MagpieRoutePanel({ rpc, usage, quotas, t, expandedGroups, onToggleGroup }),
    ),
  )
}

function MagpieUsagePanel({ usage, aggregateRows, sessionRows, t }: {
  readonly usage: MagpieUsageSnapshot
  readonly aggregateRows: readonly (readonly [string, string | null])[]
  readonly sessionRows: readonly (readonly [string, string | null])[]
  readonly t: CodingNsTranslator
}): ReactElement {
  return createElement('div', undefined,
    createElement('section', { style: magpieUsageSectionStyle },
      createElement('strong', { style: magpieSectionTitleStyle }, t('usage.magpieAggregateTitle')),
      usage.usageStatus === 'available'
        ? createMagpieRows(aggregateRows)
        : createElement('div', { style: magpieMutedTextStyle }, t('usage.magpieUsageUnavailable')),
    ),
    createElement('section', { style: magpieUsageSectionStyle },
      createElement('strong', { style: magpieSectionTitleStyle }, t('usage.magpieSessionTitle')),
      usage.sessionId !== null && createElement('div', { style: magpieSessionIdentityStyle },
        createElement('span', undefined, t('usage.magpieAgent', { agent: usage.agent })),
        usage.sessionName !== undefined && createElement('strong', { style: magpieSessionNameStyle, title: usage.sessionName }, usage.sessionName),
        createElement('code', { style: magpieSessionIdStyle }, usage.sessionId),
      ),
      usage.session === null
        ? createElement('div', { style: magpieMutedTextStyle }, usage.sessionId === null ? t('usage.magpieSessionIdUnavailable') : t('usage.magpieSessionNoUsage'))
        : createMagpieRows(sessionRows),
    ),
  )
}

function magpieQuotaUnavailableMessage(usage: MagpieUsageSnapshot, quotas: readonly MagpieQuota[], t: CodingNsTranslator): string | null {
  return usage.quotaStatus === 'unavailable'
    ? t('usage.magpieQuotaUnavailable')
    : usage.quotaStatus === 'provider-unavailable'
      ? t('usage.magpieQuotaProviderUnavailable')
      : quotas.length === 0 ? t('usage.magpieQuotaNoData') : null
}

function createMagpieProviderBadges(usage: MagpieUsageSnapshot, style: Record<string, string | number>): ReactElement | null {
  const providers = usage.upstreamProviders ?? (usage.upstreamProvider === null ? [] : [usage.upstreamProvider])
  if (providers.length === 0) return null
  return createElement('span', { style }, ...providers.map((provider) => createElement('span', { key: provider, style: magpieProviderBadgeStyle }, provider)))
}

function createMagpieQuotaCard(quota: MagpieQuota, t: CodingNsTranslator, index: number): ReactElement {
  return createElement('div', { key: `${quota.provider}-${quota.user ?? 'account'}-${index}`, style: magpieQuotaCardStyle },
    createElement('div', { style: magpieQuotaCardHeadingStyle },
      createElement('span', { style: magpieQuotaNameWithLogoStyle },
        createElement(MagpieProviderLogo, { identities: [quota.provider, quota.name], logoDataUrl: quota.logoDataUrl, size: 20, className: 'codingns4dsh-magpie-quota-logo', fallback: 'none' }),
        createElement('span', { style: magpieQuotaNameStyle }, quota.alias ?? quota.name),
      ),
      createElement('span', { style: magpieQuotaHeadingMetaStyle }, quota.plan ?? quota.provider),
    ),
    (quota.user !== null || quota.balance !== null) && createElement('div', { style: magpieQuotaIdentityStyle },
      quota.user !== null && createElement('span', { title: quota.user }, t('usage.magpieQuotaAccount', { account: quota.user })),
      quota.balance !== null && createElement('span', undefined, t('usage.magpieQuotaBalance', { balance: quota.balance })),
    ),
    quota.windows.length === 0
      ? createElement('div', { style: magpieQuotaMetaStyle }, t('usage.magpieQuotaNoWindows'))
      : quota.windows.map((window, windowIndex) => {
          const remaining = window.remainingPercent
          // 积分窗口（WorkBuddy 的 `0 / 350`）按数量读更准确：百分比在这里没有意义。
          const credits = formatQuotaWindowCredits(window)
          const amount = window.display ?? (window.amount !== null && window.limit !== null ? `${window.amount} / ${window.limit}${window.unit === null ? '' : ` ${window.unit}`}` : null)
          return createElement('div', { key: `${window.name}-${windowIndex}`, style: magpieQuotaWindowStyle },
            createElement('div', { style: windowHeadingStyle },
              createElement('span', undefined, window.name),
              credits !== null
                ? createElement('strong', undefined, credits)
                : remaining === null ? amount : createElement('strong', undefined, `${formatPercent(remaining)}%`),
            ),
            // 积分窗口用满格数量条展示已用比例，避免"0% 还能用"的误读。
            remaining !== null && createElement('div', { role: 'progressbar', 'aria-label': t('usage.magpieQuotaRemaining', { name: window.name, percent: formatPercent(remaining) }), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': remaining, style: barStyle },
              createElement('span', { style: { ...barFillStyle, width: `${remaining}%` } }),
            ),
            (amount !== null || window.resetsAt !== null) && createElement('div', { style: magpieQuotaFooterStyle },
              amount !== null && createElement('span', undefined, amount),
              window.resetsAt !== null && createElement('span', undefined, t('usage.magpieQuotaResets', { time: formatMagpieTimestamp(window.resetsAt) })),
            ),
          )
        }),
  )
}

/**
 * 单个窗口若是按积分计量，返回"剩余 / 上限"文本；普通百分比窗口返回 null。
 *
 * 卡片会为每个窗口单独调用一次，所以这里按窗口自治判断，不依赖账号整体状态。
 */
function formatQuotaWindowCredits(window: MagpieQuotaWindow): string | null {
  const credits = readWindowCreditBalance(window)
  return credits === null ? null : formatQuotaCredits(credits)
}

function MagpieRoutePanel({ rpc, usage, quotas, t, expandedGroups, onToggleGroup }: {
  readonly rpc: CodingNsRpcClient
  readonly usage: MagpieUsageSnapshot
  readonly quotas: readonly MagpieQuota[]
  readonly t: CodingNsTranslator
  readonly expandedGroups: readonly string[]
  readonly onToggleGroup: (provider: string) => void
}): ReactElement {
  const route = usage.route
  const groups = groupQuotasByProvider(quotas)
  const sessionAccount = route?.providerAccount ?? null
  const quotaMessage = magpieQuotaUnavailableMessage(usage, quotas, t)
  const routeStatus = usage.routeStatus === 'no-route'
    ? t('usage.magpieRouteNoRequests')
    : usage.routeStatus === 'session-unavailable'
      ? t('usage.magpieSessionIdUnavailable')
      : t('usage.magpieRouteUnavailable')
  const routeStages = route === null ? [] : ([
    [t('usage.magpieAskedModel'), route.asked],
    [t('usage.magpieRoutedModel'), route.model],
    [t('usage.magpieServedModel'), route.served],
  ] as const).filter((stage, index, all): stage is readonly [string, string] => stage[1] !== null && all.findIndex((item) => item[1] === stage[1]) === index)
  const active = route?.done === false
  const routeRows = route === null ? [] : [
    [t('usage.magpieRouteGroup'), route.group],
    [t('usage.magpieRouteRule'), route.rule],
    [t('usage.magpieRouteAccount'), route.providerAccount ?? null],
    [t('usage.magpieEffort'), route.effort],
    [t('usage.magpieRequestStatus'), route.status === null ? null : `${route.done === true ? t('usage.magpieRouteDone') : route.done === false ? t('usage.magpieRouteRunning') : ''}${route.status}`],
  ] as const
  return createElement('div', undefined,
    createElement('section', { style: magpieSectionStyle },
      createElement('div', { style: magpieQuotaHeadingStyle },
        createElement('strong', { style: magpieSectionTitleStyle }, t('usage.magpieQuotaTitle')),
        createMagpieProviderBadges(usage, magpieProviderBadgesStyle),
      ),
      quotaMessage !== null
        ? createElement('div', { style: magpieEmptyStateStyle }, quotaMessage)
        : groups.map((group) => {
          const expanded = expandedGroups.includes(group.provider)
          const multiple = group.accounts.length > 1
          return createElement('div', { key: group.provider, style: magpieQuotaCardStyle },
            createQuotaGroupHeader({
              group,
              t,
              expanded,
              onToggle: multiple ? () => onToggleGroup(group.provider) : null,
            }),
            group.accounts.map((quota, index) => createElement('div', { key: `${group.provider}-${quota.user ?? 'account'}-${index}` },
              createQuotaAccountBlock(quota, {
                t,
                nowMs: Date.now(),
                // 单账号厂商由组头承担名称，账号块不再重复。
                showAccountName: multiple,
                // 组未展开时只留会话账号的明细，其余账号折叠成余量行。
                compact: multiple && !expanded && quota.active !== true && (sessionAccount === null || quota.user !== sessionAccount),
                fallbackName: group.name === '' ? group.provider : group.name,
              }),
            )),
          )
        }),
    ),
    createElement('section', { style: magpieSectionStyle },
      createElement('div', { style: magpieRouteHeadingStyle },
        createElement('strong', { style: magpieSectionTitleStyle }, t('usage.magpieRouteTitle')),
        route !== null && createElement('div', { style: magpieRouteHeadingActionsStyle },
          // “查看请求”入口与状态徽标同高、同排：入口在左，状态在右。
          createElement(MagpieRouteRequests, {
            rpc,
            sessionId: usage.sessionId,
            sessionName: usage.sessionName ?? null,
            agent: usage.agent,
            t,
          }),
          createElement('span', { className: active ? 'codingns4dsh-magpie-route-node-active' : undefined, style: magpieRouteStatusStyle },
            createElement('span', { style: magpieRouteStatusDotStyle }),
            createElement('strong', undefined, route.done === true ? t('usage.magpieRouteComplete') : route.done === false ? t('usage.magpieRouteRunning').replace(/\s*·\s*$/u, '') : route.status ?? '--'),
          ),
        ),
      ),
      route === null
        ? createElement('div', { style: magpieEmptyStateStyle }, routeStatus)
        : createElement('div', { style: magpieRouteHeroStyle },
            createElement('div', { style: magpieRouteTrackStyle, 'aria-label': t('usage.magpieRouteFlowTitle'), role: 'list' },
              ...routeStages.map(([label, model], index) => createElement('div', {
                key: `step-${index}`,
                className: 'codingns4dsh-magpie-route-step',
                role: 'listitem',
                style: { ...magpieRouteTrackItemStyle, animationDelay: `${index * 90}ms` },
              },
                createElement('div', { style: magpieRouteMarkerColumnStyle, 'aria-hidden': true },
                  createElement('div', { className: 'codingns4dsh-magpie-route-node', style: magpieRouteNodeStyle }, createElement('span', { style: magpieRouteNodeDotStyle })),
                  index < routeStages.length - 1 && createElement('div', { style: magpieRouteConnectorStyle }, active && createElement('span', { className: 'codingns4dsh-magpie-route-pulse', style: magpieRoutePulseStyle })),
                ),
                createElement('div', { style: magpieRouteStageCopyStyle },
                  createElement('span', { style: magpieRouteStageLabelStyle }, label),
                  createElement('strong', { style: magpieRouteStageValueStyle, title: model }, model),
                ),
              )),
            ),
            routeRows.length > 0 && createElement('div', { style: magpieRouteMetaStyle }, ...routeRows.filter((row): row is readonly [string, string] => row[1] !== null).map(([label, value]) => createElement('div', { key: label, style: magpieRouteMetaItemStyle },
              createElement('span', { style: magpieRouteMetaLabelStyle }, label),
              createElement('strong', { style: magpieRouteMetaValueStyle, title: value }, value),
            ))),
            route.tries.length > 0 && createElement('div', { style: magpieAttemptsStyle }, ...route.tries.map((attempt, index) => createElement('div', { key: `${attempt.model ?? 'model'}-${index}`, style: magpieAttemptRowStyle },
              createElement('span', { style: magpieAttemptModelStyle }, attempt.model ?? t('usage.magpieUnknownModel')),
              attempt.failed && createElement('span', { style: magpieFailedStyle }, t('usage.magpieFallback')),
            ))),
          ),
    ),
  )
}

/**
 * 路由标题栏的“查看请求”入口：按钮、模态框与读取状态放在同一个子组件里。
 *
 * 弹层内容本身不持有 Hook（无浏览器测试会直接展开内容树），因此这里只由
 * `MagpieRoutePanel` 渲染元素，真正的状态留在本组件内部。模态框内的请求明细
 * 直接复用管理页的 `RequestsPage`，只把会话筛选固定为当前会话。
 */
export function MagpieRouteRequests({ rpc, sessionId, sessionName, agent, t }: {
  readonly rpc: CodingNsRpcClient
  readonly sessionId: string | null
  readonly sessionName: string | null
  readonly agent: string
  readonly t: CodingNsTranslator
}): ReactElement {
  const enabled = canReadMagpieSessionRequests(sessionId, agent)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<MagpieUsageRequestPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open || !enabled) return
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError(false)
    void readMagpieSessionRequestPage(rpc, sessionId, agent, offset, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      if (next === null) { setError(true); return }
      setPage(next)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => {
      controller.abort()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [open, enabled, offset, reloadKey, rpc, sessionId, agent])

  // 模态框覆盖整个视口，Esc 是移动端之外唯一的键盘关闭方式。
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    // 捕获阶段拦截 Esc：只关闭模态框，不再让底部弹层的关闭监听把整个弹层一起收起。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const close = (): void => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setOpen(false)
  }

  const openRequests = (): void => {
    controllerRef.current?.abort()
    setPage(null)
    setOffset(0)
    setError(false)
    setLoading(true)
    // 请求明细复用管理页组件，需要先装上管理页自己的样式表。
    installMagpiePageStyles()
    setOpen(true)
  }

  return createElement(Fragment, undefined,
    enabled && createElement('button', {
      type: 'button',
      className: 'codingns4dsh-magpie-route-requests',
      onClick: openRequests,
      'aria-haspopup': 'dialog',
      title: t('usage.magpieViewRequests'),
      style: magpieRouteRequestsButtonStyle,
    }, t('usage.magpieViewRequests')),
    enabled && open && createElement(MagpieSessionRequestsDialog, {
      sessionId,
      sessionName,
      agent,
      page,
      offset,
      loading,
      error,
      t,
      onClose: close,
      onOffsetChange: setOffset,
      onRetry: () => { setLoading(true); setError(false); setReloadKey((value) => value + 1) },
    }),
  )
}

/** Host 只接受小写 Agent ID；会话与 Agent 必须成对出现，缺一不可。 */
function canReadMagpieSessionRequests(sessionId: string | null, agent: string): sessionId is string {
  return sessionId !== null && sessionId.trim() !== '' && sessionId.length <= 512 && /^[a-z0-9][a-z0-9-]*$/u.test(agent)
}

/** 只读取今天的会话请求，与路由卡片和“当前 Agent 会话”用量保持同一时间口径。 */
async function readMagpieSessionRequestPage(
  rpc: CodingNsRpcClient,
  sessionId: string,
  agent: string,
  offset: number,
  signal: AbortSignal,
): Promise<MagpieUsageRequestPage | null> {
  const result = await callCodingNsRpcResult(rpc, 'magpie/usage/requests', {
    period: 'today',
    offset,
    limit: MAGPIE_REQUESTS_PAGE_SIZE,
    sessionId,
    sessionAgent: agent,
  }, signal)
  if (!result.ok) throw new Error(result.error.message)
  const value: unknown = result.value
  return isRecord(value) && Array.isArray(value.items)
    ? value as unknown as MagpieUsageRequestPage
    : null
}

/**
 * 请求模态框：外壳（遮罩、标题、关闭）由弹层提供，明细直接复用管理页的请求用量视图。
 *
 * 管理页视图自带统计条、桌面表格 / 移动卡片、分页和空状态，这里只负责把会话固定住，
 * 不再维护一套重复的请求卡片渲染。
 */
function MagpieSessionRequestsDialog({ sessionId, sessionName, agent, page, offset, loading, error, t, onClose, onOffsetChange, onRetry }: {
  readonly sessionId: string
  readonly sessionName: string | null
  readonly agent: string
  readonly page: MagpieUsageRequestPage | null
  readonly offset: number
  readonly loading: boolean
  readonly error: boolean
  readonly t: CodingNsTranslator
  readonly onClose: () => void
  readonly onOffsetChange: (value: number) => void
  readonly onRetry: () => void
}): ReactElement {
  return createElement('div', {
    className: 'codingns4dsh-magpie-requests-overlay',
    role: 'presentation',
    style: magpieRequestsOverlayStyle,
    // 只有按在遮罩自身时才关闭；从内容内部按下再拖到遮罩上不会误关。
    onPointerDown: backdropPointerDownHandler(onClose),
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('usage.magpieRequestsTitle'),
      className: 'codingns4dsh-magpie-requests-dialog',
      tabIndex: -1,
      autoFocus: true,
      style: magpieRequestsDialogStyle,
    },
      createElement('div', { style: magpieRequestsHeadingStyle },
        createElement('strong', { style: magpieRequestsTitleStyle }, t('usage.magpieRequestsTitle')),
        createElement('div', { style: magpieRequestsHeadingActionsStyle },
          error && createElement('button', {
            type: 'button',
            className: 'codingns4dsh-magpie-requests-retry',
            onClick: onRetry,
            style: magpieRequestsRetryStyle,
          }, t('magpie.refresh')),
          createElement('button', {
            type: 'button',
            className: 'codingns4dsh-magpie-requests-close',
            onClick: onClose,
            'aria-label': t('usage.magpieRequestsClose'),
            style: magpieRequestsCloseStyle,
          }, '×'),
        ),
      ),
      createElement('div', { className: 'codingns4dsh-magpie-requests-body', style: magpieRequestsBodyStyle },
        // `.codingns-magpie-page` 提供管理页的 `--mp-*` 主题变量；外层样式再把它压进弹层尺寸。
        createElement('div', { className: 'codingns-magpie-page codingns4dsh-magpie-requests-view' },
          createElement(RequestsPage, {
            page,
            loading,
            error,
            selectedSession: { id: sessionId, agent, ...(sessionName === null ? {} : { dshSessionName: sessionName }) },
            offset,
            onOffsetChange,
            onClearSession: null,
            t,
          }),
        ),
      ),
    ),
  )
}

function createMagpieRows(rows: readonly (readonly [string, string | null])[]): ReactElement {
  if (rows.length === 0) return createElement('div', { style: magpieMutedTextStyle }, '--')
  return createElement('div', { style: magpieStatsGridStyle }, ...rows.map(([label, value]) => createElement('div', { key: label, style: magpieStatStyle },
    createElement('span', { style: magpieStatLabelStyle }, label),
    createElement('strong', { style: magpieRowValueStyle }, value ?? '--'),
  )))
}

function formatMagpieNumber(value: number | null): string | null {
  return value === null ? null : formatInteger(value)
}

function formatMagpieTokenCount(value: number | null): string | null {
  return value === null ? null : formatCompactTokenCount(value)
}

function formatMagpieCost(value: number | null): string | null {
  return value === null ? null : `$${value.toFixed(value >= 0.01 ? 2 : 4)}`
}

function formatMagpieCacheHitRate(inputTokens: number | null, cacheReadTokens: number | null): string | null {
  if (inputTokens === null || cacheReadTokens === null) return null
  const totalPromptTokens = inputTokens + cacheReadTokens
  return totalPromptTokens <= 0 ? null : formatSub2ApiPercent(cacheReadTokens / totalPromptTokens * 100)
}

function sumKnownCounts(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function formatMagpieTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp) : value
}

function normalizeSubscriptionSnapshot(value: unknown): CliSubscriptionSnapshot | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return null
  if ('providerUsage' in value || 'magpie' in value) {
    const providerUsage = isRecord(value.providerUsage) ? value.providerUsage as unknown as CliSubscriptionUsage : null
    const magpie = isRecord(value.magpie) ? value.magpie as unknown as MagpieUsageSnapshot : null
    return { providerUsage, magpie }
  }
  // Compatibility with Hosts that returned the provider usage directly.
  return { providerUsage: value as unknown as CliSubscriptionUsage, magpie: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
        createElement('strong', { style: { fontSize: uiFontSize(14), lineHeight: 1.4 } }, t('usage.resetDialogTitle')),
        createElement('span', { style: { color: messageColor, fontSize: uiFontSize(12), lineHeight: '18px' } }, message),
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

export function ProviderBalancePopover({ usage, providerName, t, nowMs }: { readonly usage: ProviderBalanceUsage; readonly providerName: string; readonly t: CodingNsTranslator; readonly nowMs: number }): ReactElement {
  const models = summarizeProviderBalance(usage)
  const overallPercent = balancePercent(usage.remaining, usage.total)
  const details = usage.details.filter((item) => !isProviderModelDetail(item.label))
  return createElement('div', { className: 'codingns4dsh-subscription-popover', role: 'dialog', 'aria-label': t('usage.officialRemainingPopover', { provider: providerName }), style: subscriptionPopoverStyle },
    createElement('div', { style: popoverHeadingStyle },
      createElement('span', { style: providerBalanceHeadingStyle },
        createElement('strong', undefined, usage.r4 === undefined ? providerName : t('usage.upstreamUsageTitle', { provider: providerName })),
        usage.r4 === undefined && usage.planName?.trim() && createElement('span', { style: providerBalancePlanStyle }, usage.planName.trim()),
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
    usage.r4 !== undefined && createElement(R4BalanceDetails, { usage, t }),
    usage.r4 === undefined && createElement('section', { style: providerDetailsSectionStyle },
      createElement('strong', { style: providerBalanceSectionTitleStyle }, t('usage.providerDetails')),
      details.length === 0
        ? createElement('div', { style: resetStyle }, t('usage.upstreamNotProvided'))
        : details.map((item, index) => createElement('div', { key: `${item.label}-${index}`, style: providerDetailRowStyle },
          createElement('span', undefined, item.label),
          createElement('span', { style: providerDetailValueStyle }, formatProviderDetailValue(item.value, t)),
        )),
    ),
    usage.r4 !== undefined ? null : models.length === 0
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

function R4BalanceDetails({ usage, t }: { readonly usage: ProviderBalanceUsage; readonly t: CodingNsTranslator }): ReactElement {
  const data = usage.r4!
  const money = (value: number | null): string => value === null ? t('usage.upstreamNotProvided') : formatNewApiBalanceAmount(value, 'USD')
  const row = (label: string, value: string): ReactElement => createElement('div', { key: label, style: providerDetailRowStyle },
    createElement('span', undefined, label), createElement('span', { style: providerDetailValueStyle }, value))
  const unknown = t('usage.upstreamNotProvided')
  const count = (value: number | null | undefined): string => value == null ? unknown : formatInteger(value)
  const total = (values: readonly (number | null | undefined)[]): number | null => values.length === 0 || values.some((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + value!, 0)
  const tokens = (value: number | null): string => value === null ? unknown : formatCompactTokenCount(value)
  const keySummary = data.key?.unlimited ? t('usage.r4NoLimit')
    : `${money(data.key?.remaining ?? null)} / ${money(data.key?.limit ?? null)}`
  return createElement('div', undefined,
    createElement('div', { style: upstreamMetaStyle },
      createElement('span', { style: upstreamTypeStyle }, 'R4 Coder'),
      createElement('a', { href: usage.upstreamUrl, target: '_blank', rel: 'noreferrer', title: usage.upstreamUrl, style: upstreamLinkStyle }, usage.upstreamUrl),
    ),
    createElement('div', { style: { ...sub2apiStatLabelStyle, paddingTop: 8 } }, t('usage.r4StatsPeriod')),
    createElement('div', { style: sub2apiStatsGridStyle },
      createSub2ApiStat(t('usage.statTodayRequests'), count(data.today?.requests)),
      createSub2ApiStat(t('usage.r4TodayIoTokens'), tokens(total([data.today?.inputTokens, data.today?.outputTokens]))),
      createSub2ApiStat(t('usage.statTodayCost'), money(data.today?.cost ?? null)),
      createSub2ApiStat(t('usage.r4WeekRequests'), count(total(data.daily.map((point) => point.requests)))),
      createSub2ApiStat(t('usage.r4WeekIoTokens'), tokens(total(data.daily.map((point) => total([point.inputTokens, point.outputTokens]))))),
      createSub2ApiStat(t('usage.r4WeekCost'), money(total(data.daily.map((point) => point.cost)))),
    ),
    createElement('section', { style: sub2apiSectionStyle },
      createElement('strong', { style: sub2apiSectionTitleStyle }, t('usage.r4ModelsWeek')),
      data.models.length === 0 ? createElement('div', { style: resetStyle }, t('usage.noModelStats'))
        : createElement('div', { style: sub2apiTableScrollStyle },
          createElement('table', { style: sub2apiTableStyle },
            createElement('thead', undefined, createElement('tr', undefined,
              ...[t('usage.colModel'), t('usage.colRequests'), t('usage.colCost')].map((label) => createElement('th', { key: label, style: sub2apiThStyle }, label)),
            )),
            createElement('tbody', undefined, ...data.models.map((model, index) => createElement('tr', { key: index },
              createElement('td', { style: { ...sub2apiTdStyle, overflowWrap: 'anywhere' } }, model.name),
              createElement('td', { style: sub2apiTdStyle }, count(model.requests)),
              createElement('td', { style: sub2apiTdStyle }, money(model.cost)),
            ))),
          ),
        ),
    ),
    createElement('div', { style: { borderTop: `1px solid ${dshThemeColor.border}`, paddingTop: 10, marginTop: 10 } },
      row(t('usage.r4KeyRemainingLimit'), keySummary),
    ),
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
/** 配额解析完成前的补读间隔；与弹层打开时的路由读取共用串行轮询。 */
const MAGPIE_QUOTA_RETRY_MS = 3_000

/**
 * Magpie 用量入口是否还需要带路由补读。
 *
 * Host 会为「已确认属于 Magpie、但会话身份还没写进账本」的模型下发带会话数据的
 * `provider-unavailable` 占位快照；还在启动中的网关则是 `unavailable`。
 * 两种状态都表示上游未知，必须按 `MAGPIE_QUOTA_RETRY_MS` 快速重新解析，否则首屏
 * 会一直停在官方余额或 Magpie 标签上，直到整页刷新。
 *
 * 上游已解析（`provider-unavailable` 但 `upstreamProvider` 有值，例如该厂商本来
 * 就不上报任何配额窗口）不再补读——再读也只是重复确认同一个结论。没有上游信息的
 * 占位快照才有资格要求补读，Host 也只在这种情况下才下发它。
 */
function shouldResolveMagpieQuota(usage: MagpieUsageSnapshot | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  if (usage.quotaStatus !== 'available') return usage.upstreamProvider === null
  return usage.sessionId !== null && usage.session !== null && usage.quotas.length === 0
}
function resolveMagpieQuotaRemaining(usage: MagpieUsageSnapshot): number | null {
  if (usage.quotaStatus !== 'available') return null
  for (const quota of usage.quotas) {
    for (const window of quota.windows) {
      if (window.remainingPercent !== null) return window.remainingPercent
    }
  }
  return null
}
/**
 * 底部 Magpie 入口在折叠态下该说什么。
 *
 * 优先级：额度窗口的百分比环 → 金额余额（New-API 的 `$74.40`）→ 积分余额
 * （WorkBuddy 的 `350`）→ Magpie 标签。积分没有百分比可用，只显示剩余数量，
 * 避免出现"永远 0%"的空环。
 */
type MagpieTriggerReadout =
  | { readonly kind: 'ring'; readonly percent: number }
  | { readonly kind: 'money'; readonly text: string }
  | { readonly kind: 'credits'; readonly text: string }
  | { readonly kind: 'label' }
function resolveMagpieTriggerReadout(usage: MagpieUsageSnapshot): MagpieTriggerReadout {
  const remaining = resolveMagpieQuotaRemaining(usage)
  if (remaining !== null) return { kind: 'ring', percent: remaining }
  const quotas = usage.quotas ?? []
  const balance = resolveQuotaBalanceLabel(quotas)
  if (balance !== null) return { kind: 'money', text: balance }
  const credits = resolveQuotaCreditsLabel(quotas)
  if (credits !== null) return { kind: 'credits', text: credits }
  return { kind: 'label' }
}
/** 积分余额的展示文本：只给数量，单位放在 title 里，不占用底部栏宽度。 */
function resolveQuotaCreditsLabel(quotas: readonly MagpieQuota[]): string | null {
  for (const quota of quotas) {
    const credits = resolveQuotaCreditBalance(quota)
    if (credits === null || !(credits.remaining > 0)) continue
    return formatQuotaNumber(credits.remaining)
  }
  return null
}
function createMagpieTriggerReadout(readout: MagpieTriggerReadout, t: CodingNsTranslator): ReactElement {
  switch (readout.kind) {
    case 'ring':
      return createRemainingRing(readout.percent)
    case 'money':
      return createElement('span', { className: 'codingns4dsh-subscription-value', style: magpieBalanceStyle, title: t('usage.accountBalance') }, readout.text)
    case 'credits':
      return createElement('span', { className: 'codingns4dsh-subscription-value', style: magpieBalanceStyle, title: t('usage.creditBalanceLabel') }, readout.text)
    default:
      return createElement('span', { className: 'codingns4dsh-subscription-label', style: subscriptionLabelStyle }, t('usage.magpieShortLabel'))
  }
}
function selectDeepseekBalance(usage: DeepseekUsage): DeepseekUsage['balances'][number] | null {
  return usage.balances.find((balance) => balance.currency.toUpperCase() === 'USD') ?? usage.balances[0] ?? null
}
/** 已具备用量读取契约的适配器才挂载底部订阅入口。 */
function isSubscriptionAdapter(adapterId: unknown): adapterId is 'antigravity' | 'command-code' | 'codex' | 'claude-code' | 'codebuddy' | 'codebuddy-cn' | 'dsh' | 'grok' | 'kimi' | 'opencode' | 'pi' | 'qoder' | 'qoder-cn' | 'workbuddy' | 'zcode' {
  return adapterId === 'antigravity' || adapterId === 'command-code' || adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'codebuddy' || adapterId === 'codebuddy-cn' || adapterId === 'dsh' || adapterId === 'grok' || adapterId === 'kimi' || adapterId === 'opencode' || adapterId === 'pi' || adapterId === 'qoder' || adapterId === 'qoder-cn' || adapterId === 'workbuddy' || adapterId === 'zcode'
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
const subscriptionTriggerStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, border: 0, borderRadius: 14, padding: '0 8px 0 4px', color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: uiFontSize(13), lineHeight: '20px' }
const subscriptionLabelStyle = { whiteSpace: 'nowrap' as const }
// 余额金额与积分和百分比环并排/替换显示：数字用等宽字形，避免刷新时抖动。
const magpieBalanceStyle = { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' as const, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const magpieTriggerIconStyle = { display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 6, background: dshThemeColor.surfaceSubtle }
const magpieTriggerImageStyle = { display: 'block', width: '100%', height: '100%', objectFit: 'cover' as const }
const magpieMutedTextStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '17px', overflowWrap: 'anywhere' as const }
const magpieHeaderMutedStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '17px', overflowWrap: 'anywhere' as const }
const magpieHeaderMetaStyle = { display: 'grid', justifyItems: 'end', gap: 3, minWidth: 0, textAlign: 'right' as const }
const magpiePopoverHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 22, paddingBottom: 12, borderBottom: `1px solid ${dshThemeColor.border}`, fontSize: uiFontSize(15) }
const magpiePopoverHeadingTextStyle = { display: 'grid', gap: 3, minWidth: 0 }
const magpieSectionTitleStyle = { fontSize: uiFontSize(13), color: dshThemeColor.labelSecondary }
const magpieTabsStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, marginTop: 8, padding: 3, borderRadius: 9, background: dshThemeColor.surfaceSubtle }
const magpieTabStyle = { minWidth: 0, padding: '6px 8px', border: 0, borderRadius: 8, background: 'transparent', color: dshThemeColor.labelTertiary, cursor: 'pointer', fontSize: uiFontSize(12), lineHeight: '16px', whiteSpace: 'nowrap' as const }
const magpieTabActiveStyle = { background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxShadow: `0 1px 3px ${dshThemeColor.border}` }
const magpieTabPanelStyle = { minHeight: 0 }
const magpieSectionStyle = { display: 'grid', gap: 8, paddingTop: 11, marginTop: 10, borderTop: `1px solid ${dshThemeColor.border}` }
const magpieUsageSectionStyle = { display: 'grid', gap: 5, paddingTop: 8, marginTop: 7, borderTop: `1px solid ${dshThemeColor.border}` }
const magpieStatsGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, paddingTop: 0 }
const magpieStatStyle = { display: 'grid', alignContent: 'space-between', gap: 1, minWidth: 0, minHeight: 40, boxSizing: 'border-box' as const, padding: '5px 7px', borderRadius: 8, background: dshThemeColor.surfaceSubtle }
const magpieStatLabelStyle = { minWidth: 0, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(10), lineHeight: '13px', overflowWrap: 'anywhere' as const }
const magpieRowValueStyle = { color: dshThemeColor.labelPrimary, fontSize: uiFontSize(14), fontWeight: 650, lineHeight: '18px', textAlign: 'right' as const, overflowWrap: 'anywhere' as const }
const magpieSessionIdentityStyle = { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'baseline', gap: '2px 10px', minWidth: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: '16px' }
const magpieSessionNameStyle = { maxWidth: '100%', overflow: 'hidden', color: dshThemeColor.labelPrimary, fontSize: uiFontSize(12), fontWeight: 650, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const magpieSessionIdStyle = { flex: '1 1 120px', minWidth: 0, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(10), lineHeight: '14px', whiteSpace: 'normal' as const, overflowWrap: 'anywhere' as const }
const magpieAttemptsStyle = { display: 'grid', gap: 5, paddingTop: 6 }
const magpieAttemptRowStyle = { display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: uiFontSize(12) }
const magpieAttemptModelStyle = { color: dshThemeColor.labelSecondary, overflowWrap: 'anywhere' as const }
const magpieFailedStyle = { flex: 'none', color: dshThemeColor.error, fontSize: uiFontSize(11) }
const magpieQuotaHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }
const magpieProviderBadgesStyle = { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap' as const, gap: 5, minWidth: 0 }
const magpieProviderBadgeStyle = { flex: 'none', maxWidth: 220, overflow: 'hidden', padding: '4px 8px', borderRadius: 999, background: dshThemeColor.surfaceSubtle, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const magpieEmptyStateStyle = { display: 'grid', placeItems: 'center', minHeight: 36, padding: '8px 10px', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '17px', textAlign: 'center' as const }
const magpieQuotaCardStyle = { display: 'grid', gap: 5, marginTop: 7, padding: '9px 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 9, background: dshThemeColor.surfaceSubtle }
const magpieQuotaCardHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }
const magpieQuotaNameWithLogoStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }
const magpieQuotaNameStyle = { minWidth: 0, overflow: 'hidden', color: dshThemeColor.labelPrimary, fontSize: uiFontSize(13), fontWeight: 650, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const magpieQuotaHeadingMetaStyle = { flex: 'none', maxWidth: 160, overflow: 'hidden', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const magpieQuotaIdentityStyle = { display: 'flex', flexWrap: 'wrap' as const, gap: '3px 12px', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '15px', overflowWrap: 'anywhere' as const }
const magpieQuotaMetaStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '15px', overflowWrap: 'anywhere' as const }
const magpieQuotaWindowStyle = { display: 'grid', gap: 4, paddingTop: 3 }
const magpieQuotaFooterStyle = { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: '3px 10px', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '15px' }
const magpieRouteHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }
const magpieRouteHeroStyle = { display: 'grid', gap: 11, padding: '12px 13px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 12, background: `linear-gradient(145deg, ${dshThemeColor.surfaceSubtle}, transparent)` }
const magpieRouteStatusStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, width: 'fit-content', boxSizing: 'border-box' as const, padding: '3px 8px', borderRadius: 999, background: dshThemeColor.surfaceSubtle, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), lineHeight: '15px', whiteSpace: 'nowrap' as const }
const magpieRouteStatusDotStyle = { width: 8, height: 8, borderRadius: '50%', background: dshThemeColor.accent }
const magpieRouteTrackStyle = { display: 'grid', gap: 0, minWidth: 0, padding: '3px 0' }
const magpieRouteTrackItemStyle = { display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', alignItems: 'start', gap: 12, minWidth: 0, padding: '5px 8px', margin: '0 -8px', borderRadius: 8 }
const magpieRouteMarkerColumnStyle = { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', minHeight: 18 }
const magpieRouteNodeStyle = { display: 'grid', flex: '0 0 18px', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', background: dshThemeColor.menuBackground, boxShadow: `0 0 0 1px ${dshThemeColor.border}` }
const magpieRouteNodeDotStyle = { width: 7, height: 7, borderRadius: '50%', background: dshThemeColor.accent }
const magpieRouteStageCopyStyle = { display: 'grid', gap: 3, minWidth: 0, padding: '2px 0 3px' }
const magpieRouteStageLabelStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(10), lineHeight: '13px', letterSpacing: '.025em' }
const magpieRouteStageValueStyle = { color: dshThemeColor.labelPrimary, fontSize: uiFontSize(12), fontWeight: 620, lineHeight: '16px', overflowWrap: 'anywhere' as const }
const magpieRouteConnectorStyle = { width: 2, height: 28, marginTop: 4, overflow: 'hidden' as const, borderRadius: 2, background: `linear-gradient(180deg, ${dshThemeColor.accent}, ${dshThemeColor.border})` }
const magpieRoutePulseStyle = { display: 'block', width: '100%', height: 9, borderRadius: 2, background: dshThemeColor.accent, boxShadow: `0 0 6px ${dshThemeColor.accent}` }
const magpieRouteMetaStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }
const magpieRouteMetaItemStyle = { display: 'grid', alignContent: 'start', gap: 3, minWidth: 0, padding: '6px 8px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, background: dshThemeColor.menuBackground }
const magpieRouteMetaLabelStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(10), lineHeight: '13px' }
const magpieRouteMetaValueStyle = { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), fontWeight: 550, lineHeight: '15px', overflowWrap: 'anywhere' as const }
// 请求入口与请求模态框：入口与状态徽标同高并排在标题栏，模态框覆盖视口并在内部滚动。
const magpieRouteHeadingActionsStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }
const magpieRouteRequestsButtonStyle = { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, boxSizing: 'border-box' as const, padding: '2px 8px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 999, background: dshThemeColor.menuBackground, color: dshThemeColor.labelSecondary, fontFamily: 'inherit', fontSize: uiFontSize(11), lineHeight: '15px', cursor: 'pointer', whiteSpace: 'nowrap' as const, transition: 'background .15s ease,color .15s ease' }
const magpieRequestsOverlayStyle = { position: 'fixed' as const, inset: 0, zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' as const, background: dshThemeColor.overlay }
const magpieRequestsDialogStyle = { ...dshPopupSurfaceStyle, display: 'flex', flexDirection: 'column' as const, gap: 10, width: 'min(96vw, 1320px)', maxHeight: 'min(88vh, 820px)', boxSizing: 'border-box' as const, padding: 14, borderRadius: 14 }
const magpieRequestsHeadingStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}` }
const magpieRequestsHeadingActionsStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }
const magpieRequestsTitleStyle = { fontSize: uiFontSize(15), lineHeight: '20px' }
const magpieRequestsCloseStyle = { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', color: dshThemeColor.labelSecondary, fontSize: uiFontSize(18), lineHeight: 1, cursor: 'pointer' }
const magpieRequestsBodyStyle = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' as const, overscrollBehavior: 'contain' as const }
const magpieRequestsRetryStyle = { padding: '5px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 999, background: dshThemeColor.menuBackground, color: dshThemeColor.labelSecondary, fontFamily: 'inherit', fontSize: uiFontSize(11), lineHeight: '15px', cursor: 'pointer' }
const sub2apiIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' }
const sub2apiLogoStyle = { display: 'block', borderRadius: 4, objectFit: 'contain' as const }
const deepseekBalanceIdentityStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const }
const deepseekLogoStyle = { display: 'block', borderRadius: 5, objectFit: 'contain' as const }
const deepseekBalanceStyle = { display: 'inline-flex', alignItems: 'center', color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13), fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const providerBalanceHeadingStyle = { display: 'grid', gap: 2, minWidth: 0 }
const providerBalancePlanStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const deepseekBalanceSectionStyle = { display: 'grid', gap: 6, marginTop: 10, padding: '10px 0 2px', borderTop: `1px solid ${dshThemeColor.border}` }
const deepseekBalanceDetailsStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12) }
const overallBalanceStyle = { display: 'grid', gap: 5, marginTop: 10 }
const providerDetailsSectionStyle = { display: 'grid', gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}` }
const providerBalanceSectionTitleStyle = { fontSize: uiFontSize(12), color: dshThemeColor.labelSecondary }
const providerDetailRowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '17px' }
const providerDetailValueStyle = { color: dshThemeColor.labelSecondary, textAlign: 'right' as const, overflowWrap: 'anywhere' as const }
const providerBalanceModelStyle = { display: 'grid', gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}` }
const providerBalanceProgressStyle = { display: 'grid', gap: 5, marginTop: 10 }
const balanceProgressHeaderStyle = { display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), fontVariantNumeric: 'tabular-nums' as const }
const balanceProgressValueStyle = { color: dshThemeColor.labelSecondary, fontWeight: 600 }
const balanceProgressPercentStyle = { color: dshThemeColor.labelTertiary, fontVariantNumeric: 'tabular-nums' as const }
const balanceMetaStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '16px', fontVariantNumeric: 'tabular-nums' as const }
const visuallyHiddenStyle = { position: 'absolute' as const, width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden' as const, clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap' as const, border: 0 }
const providerBalanceBarStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const providerBalanceBarFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const deepseekUnavailableStatsStyle = { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '17px' }
const progressRingVisualStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 2, borderRadius: 'inherit' }
const progressRingValueStyle = { boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, borderRadius: 'inherit', background: dshThemeColor.menuBackground, fontSize: uiFontSize(7), lineHeight: 1, fontWeight: 700, color: dshThemeColor.labelPrimary, whiteSpace: 'nowrap' as const }
const progressRingSuffixStyle = { fontSize: uiFontSize(5.5), lineHeight: 1, color: dshThemeColor.labelTertiary, transform: 'translateY(1px)' }
const popoverHeadingStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}`, fontSize: uiFontSize(14) }
const popoverHeadingTextStyle = { display: 'grid', gap: 2, minWidth: 0 }
const accountMetaStyle = { overflow: 'hidden', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '16px', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const upstreamMetaStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingTop: 8, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '16px' }
const upstreamTypeStyle = { flex: '0 0 auto', color: dshThemeColor.labelSecondary, fontWeight: 600 }
const upstreamLinkStyle = { minWidth: 0, overflow: 'hidden', color: dshThemeColor.accent, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textDecoration: 'none' }
const upstreamMutedStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' as const }
const windowStyle = { display: 'grid', gap: 6, paddingTop: 10 }
const windowHeadingStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13) }
const barStyle = { height: 7, overflow: 'hidden' as const, borderRadius: 4, background: dshThemeColor.border }
const barFillStyle = { display: 'block', height: '100%', borderRadius: 4, background: dshThemeColor.accent, transition: 'width .2s ease' }
const resetStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12) }
const quotaGroupTitleStyle = { paddingTop: 12, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), fontWeight: 600, letterSpacing: '.02em' }
const subscriptionPopoverStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1200, bottom: 'calc(100% + 8px)', left: 0, width: 'max-content', minWidth: 280, maxWidth: 'min(400px, calc(100vw - 24px))', maxHeight: 'min(70vh, 560px)', overflowY: 'auto' as const, boxSizing: 'border-box' as const, padding: 14, borderRadius: 12 }
const magpiePopoverStyle = { ...subscriptionPopoverStyle, width: 400, minWidth: 0, maxWidth: 'min(400px, calc(100vw - 24px))', maxHeight: 'min(78vh, 640px)', padding: 12, borderRadius: 14 }
const resetCreditsSectionStyle = { display: 'grid', gap: 6, marginTop: 10, padding: '10px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 10, background: dshThemeColor.surfaceSubtle }
const resetCreditsRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13) }
const resetCreditsValueGroupStyle = { display: 'inline-flex', alignItems: 'center', gap: 8 }
const resetCreditsValueStyle = { color: dshThemeColor.labelPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }
const resetCreditsExpiryStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: '16px', fontVariantNumeric: 'tabular-nums' as const }
const resetDialogOverlayStyle = { position: 'fixed' as const, inset: 0, zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' as const, background: dshThemeColor.overlay }
const resetDialogStyle = { ...dshPopupSurfaceStyle, width: 'min(100%, 420px)', boxSizing: 'border-box' as const, padding: 16, borderRadius: 12, display: 'grid', gap: 12 }
const sub2apiStatsGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, paddingTop: 12 }
const sub2apiStatStyle = { display: 'grid', gap: 2, minWidth: 0 }
const sub2apiStatLabelStyle = { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11) }
const sub2apiSectionStyle = { display: 'grid', gap: 8, paddingTop: 14 }
const sub2apiSectionTitleStyle = { fontSize: uiFontSize(12), color: dshThemeColor.labelSecondary }
const sub2apiTableScrollStyle = { maxWidth: '100%', overflow: 'visible' as const }
const sub2apiTableStyle = { width: '100%', tableLayout: 'fixed' as const, borderCollapse: 'collapse' as const, fontSize: uiFontSize(11) }
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

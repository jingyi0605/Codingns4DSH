import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CODINGNS_SUBSCRIPTION_REPORTS_FIELD,
  DEFAULT_SUBSCRIPTION_REPORT_SETTINGS,
  DEFAULT_CODINGNS_SETTINGS,
  normalizeSubscriptionReportSettings,
  type CodingNsSettings,
} from '../src/shared/contracts/config.js'
import type { CodingNsSettingsSnapshot, CodingNsSettingsOperation, CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'
import { isCodingNsSettingsEntryId } from '../src/shared/contracts/config.js'
import { MagpieManagementPage, QuotasPage, QuotaViewSwitch, useQuotaView } from '../src/client/features/magpie-management-page.js'
import type { CodingNsLocale } from '../src/client/locale.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { MagpieDashboardQuota, MagpieUsageDashboard } from '../src/shared/contracts/magpie-management.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const locale = {
  bind: () => resolveCodingNsTranslator(),
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
} as unknown as CodingNsLocale
const t = resolveCodingNsTranslator()

/** 一个窗口只给百分比，另一个窗口给金额上限：两种读数都要跟着口径变化。 */
function quota(provider = 'grox-deepseek'): MagpieDashboardQuota {
  return {
    provider,
    name: 'Grox-DeepSeek',
    kind: null,
    user: 'ds-user',
    plan: '1 day',
    alias: null,
    balance: null,
    readAt: null,
    windows: [
      { name: '1 day', usedPercent: 6, remainingPercent: 94, resetsAt: null, display: null, amount: 0.35, limit: 5.27, unit: 'USD', holdsWhy: null, runsOutAt: null, runsOut: null },
      { name: '5 hours', usedPercent: null, remainingPercent: 40, resetsAt: null, display: '40%', amount: null, limit: null, unit: null, holdsWhy: null, runsOutAt: null, runsOut: null },
    ],
    daily: { since: null, days: [] },
  }
}

function dashboard(quotas: readonly MagpieDashboardQuota[]): MagpieUsageDashboard {
  return {
    period: 'today',
    capturedAt: '2026-10-23T10:00:00.000Z',
    availabilityIssue: null,
    usageStatus: 'unavailable',
    aggregate: null,
    series: [],
    agents: [],
    providers: [],
    models: [],
    accounts: [],
    sessions: [],
    sessionCount: null,
    quotaStatus: 'available',
    quotas,
    quotaHistoryStatus: 'unavailable',
    quotaHistory: [],
  }
}

/** 内存设置存储：模拟 Host 写入成功并把新值通过订阅通知回组件。 */
function memorySettings(initial: Partial<CodingNsSettings> = {}): CodingNsSettingsStore<CodingNsSettings> & { readonly writes: CodingNsSettingsOperation[][] } {
  let value: CodingNsSettings = { ...DEFAULT_CODINGNS_SETTINGS, ...initial }
  const listeners = new Set<() => void>()
  const writes: CodingNsSettingsOperation[][] = []
  let snapshot: CodingNsSettingsSnapshot<CodingNsSettings> = { value, revision: 1, writable: true, status: 'ready' }
  const publish = (): void => {
    snapshot = { value, revision: (snapshot.revision ?? 0) + 1, writable: true, status: 'ready' }
    for (const listener of listeners) listener()
  }
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(operations) {
      writes.push([...operations])
      const next = { ...value } as CodingNsSettings & Record<string, unknown>
      for (const operation of operations) {
        if (operation.op !== 'set') continue
        const [field, key] = operation.path
        if (field === undefined) continue
        if (key === undefined) next[field] = operation.value
        else next[field] = { ...(next[field] as Record<string, unknown> | undefined), [key]: operation.value }
      }
      value = next
      publish()
      return true
    },
    set: async () => true,
    unset: async () => true,
  }
}

test('订阅卡口径是 Host 级设置：默认剩余，只接受两个已知取值', () => {
  assert.equal(DEFAULT_SUBSCRIPTION_REPORT_SETTINGS.quotaView, 'remaining')
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS.subscriptionReports, DEFAULT_SUBSCRIPTION_REPORT_SETTINGS)
  assert.equal(CODINGNS_SUBSCRIPTION_REPORTS_FIELD, 'subscriptionReports')
  assert.equal(normalizeSubscriptionReportSettings({ quotaView: 'used' }).quotaView, 'used')
  assert.equal(normalizeSubscriptionReportSettings({ quotaView: 'remaining' }).quotaView, 'remaining')
  // 旧配置没有这个字段、或字段被写坏时都回落到默认读法，页面不会因此变成空态。
  assert.equal(normalizeSubscriptionReportSettings(undefined).quotaView, 'remaining')
  assert.equal(normalizeSubscriptionReportSettings({ quotaView: 'bogus' }).quotaView, 'remaining')
  assert.equal(normalizeSubscriptionReportSettings('used').quotaView, 'remaining')
  assert.equal(isCodingNsSettingsEntryId('subscriptionReports'), false, '显示口径不是独立的设置页条目')
})

test('已用口径把进度条与百分比读成消耗量，剩余口径读成余量', () => {
  const usedMarkup = renderToStaticMarkup(createElement(QuotasPage, { dashboard: dashboard([quota()]), loading: false, quotaView: 'used', t }))
  const remainingMarkup = renderToStaticMarkup(createElement(QuotasPage, { dashboard: dashboard([quota()]), loading: false, quotaView: 'remaining', t }))

  assert.match(usedMarkup, /已用 6%/u, 'used view reports the consumed share')
  assert.match(remainingMarkup, /剩余 94%/u, 'remaining view reports what is left')
  assert.match(usedMarkup, /width:6%/u, 'the bar fills to the consumed share')
  assert.match(remainingMarkup, /width:94%/u, 'the bar fills to the remaining share')
  // 只给剩余百分比的窗口同样要能换算：已用 = 100 - 剩余。
  assert.match(usedMarkup, /已用 60%/u)
  assert.match(remainingMarkup, /剩余 40%/u)
  assert.match(usedMarkup, /0\.35 \/ 5\.27 USD/u, 'the amount line is independent of the view')
})

test('订阅页工具栏最右提供「已用 / 剩余」切换，默认剩余', () => {
  const settings = memorySettings()
  const renderer = createHookRenderer(
    () => createElement(MagpieManagementPage, {
      rpc: { call: async () => ({ ok: true as const, value: null }) },
      locale,
      onClose: () => undefined,
      initialPageTab: 'usage',
      initialUsageTab: 'quotas',
      settings,
    }),
    {},
  )
  const markup = renderToStaticMarkup(renderer.render() as never)
  renderer.dispose()

  assert.match(markup, /codingns-magpie-toolbar-right/u, 'the switch sits in the toolbar right slot')
  assert.match(markup, /aria-label="订阅卡显示口径"/u, 'the control is labelled for assistive tech')
  const rightIndex = markup.indexOf('class="codingns-magpie-toolbar-right"')
  const leftIndex = markup.indexOf('class="codingns-magpie-toolbar-left"')
  assert.ok(leftIndex >= 0 && leftIndex < rightIndex, 'the view switch follows the usage tabs, pinned right')
  assert.match(markup, /codingns-magpie-quota-view-option is-active" aria-pressed="true">剩余</u, 'the default reading is 剩余')
  assert.match(markup, /aria-pressed="false">已用</u, 'used is offered but not selected')
})

test('口径切换只出现在订阅页，会话与请求报表不渲染它', () => {
  for (const tab of ['sessions', 'requests'] as const) {
    const renderer = createHookRenderer(
      () => createElement(MagpieManagementPage, {
        rpc: { call: async () => ({ ok: true as const, value: null }) },
        locale,
        onClose: () => undefined,
        initialPageTab: 'usage',
        initialUsageTab: tab,
        settings: memorySettings(),
      }),
      {},
    )
    const markup = renderToStaticMarkup(renderer.render() as never)
    renderer.dispose()
    // 样式表里始终带这些选择器，因此只检查真实渲染出来的工具栏结构。
    const toolbar = markup.slice(markup.indexOf('<div class="codingns-magpie-toolbar has-tabs"'), markup.indexOf('<main'))
    assert.match(toolbar, /codingns-magpie-usage-tabs/u, `${tab} keeps the usage tabs`)
    assert.doesNotMatch(toolbar, /codingns-magpie-quota-view/u, `${tab} has no used/remaining reading`)
  }
})

test('点击「已用」把选择写成 Host 设置，并在订阅时回读到新口径', async () => {
  const settings = memorySettings()
  const store = createHookRenderer(
    (props: { readonly settings: typeof settings }) => useQuotaView(props.settings),
    { settings },
  )
  assert.equal(store.render().quotaView, 'remaining', 'the Host default is 剩余')
  assert.equal(store.render().writable, true)

  // 控件只负责展示和回传：点击「已用」与这里调用的是同一个写入函数。
  const control = renderToStaticMarkup(createElement(QuotaViewSwitch, {
    value: 'remaining',
    disabled: false,
    failed: false,
    t,
    onChange: store.render().selectQuotaView,
  }))
  assert.match(control, /aria-pressed="false">已用</u)
  store.render().selectQuotaView('used')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(settings.writes.at(-1), [{ op: 'set', path: ['subscriptionReports', 'quotaView'], value: 'used' }], 'the choice is persisted as a Host setting')
  assert.equal(store.render().quotaView, 'used', 'the store subscription delivers the saved reading')
  store.dispose()
})

test('Host 拒绝写入时口径控件保持可读并标记失败', async () => {
  const settings = memorySettings()
  settings.mutate = async () => false
  const store = createHookRenderer(
    (props: { readonly settings: typeof settings }) => useQuotaView(props.settings),
    { settings },
  )
  store.render().selectQuotaView('used')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(store.render().quotaView, 'remaining', 'a rejected write must not change the reading')
  assert.equal(store.render().saveFailed, true, 'the failure is surfaced instead of silently ignored')
  store.dispose()
})

test('没有 Host 设置存储时页面照常渲染，口径固定为默认值', () => {
  const renderer = createHookRenderer(
    () => createElement(MagpieManagementPage, {
      rpc: { call: async () => ({ ok: true as const, value: null }) },
      locale,
      onClose: () => undefined,
      initialPageTab: 'usage',
      initialUsageTab: 'quotas',
    }),
    {},
  )
  const markup = renderToStaticMarkup(renderer.render() as never)
  renderer.dispose()
  assert.match(markup, /aria-pressed="true">剩余</u)
  assert.doesNotMatch(markup, /codingns-magpie-quota-view-option[^"]*"[^>]*disabled/u, 'static previews keep the control usable')
})

/** 构造一个只用余额、没有百分比的账号（New-API 的 `$74.14`、Sub2api 的钱包余额）。 */
function balanceOnlyQuota(provider: string, name: string, balance: string): MagpieDashboardQuota {
  return {
    provider, name, kind: null, user: null, plan: 'Default', alias: null, balance, readAt: null,
    windows: [], daily: { since: null, days: [] },
  }
}

/** 构造一个按积分计量、没有可用百分比的账号（WorkBuddy 的 `2,077.75 / 2,400 积分`）。 */
function creditQuota(provider: string, name: string, remaining: number, limit: number): MagpieDashboardQuota {
  return {
    provider, name, kind: null, user: 'zj591227045@example.com', plan: 'Free', alias: null, balance: null, readAt: null,
    windows: [{
      name: '积分', usedPercent: 13.4, remainingPercent: 86.6, resetsAt: null, display: null,
      amount: remaining, limit, unit: '积分', holdsWhy: null, runsOutAt: null, runsOut: null,
    }],
    daily: { since: null, days: [] },
  }
}



test('所有账号默认展开，多账号卡片不再藏起后几个账号', () => {
  const multi = [
    { ...quota('workbuddy'), user: 'a@example.com' },
    { ...quota('workbuddy'), user: 'b@example.com' },
    { ...quota('workbuddy'), user: 'c@example.com' },
  ]
  const markup = renderToStaticMarkup(createElement(QuotasPage, { dashboard: dashboard(multi), loading: false, t }))
  for (const account of ['a@example.com', 'b@example.com', 'c@example.com']) {
    assert.ok(markup.includes(account), `${account} is visible without clicking`)
  }
  assert.equal((markup.match(/codingns-magpie-quota-account-head/gu) ?? []).length, 3, 'every account keeps its own heading')
  assert.match(markup, /aria-expanded="true"/u, 'the collapse affordance starts expanded')
  assert.match(markup, /收起其余账号/u, 'the toggle offers to collapse, not to expand')
  assert.doesNotMatch(markup, /另 \d+ 个/u, 'no account is reported as hidden by default')
})

test('订阅磁贴用多列流式排布，短卡不留大片空白', () => {
  const renderer = createHookRenderer(
    () => createElement(MagpieManagementPage, {
      rpc: { call: async () => ({ ok: true as const, value: null }) },
      locale,
      onClose: () => undefined,
      initialPageTab: 'usage',
      initialUsageTab: 'quotas',
      settings: memorySettings(),
    }),
    {},
  )
  const markup = renderToStaticMarkup(renderer.render() as never)
  renderer.dispose()

  const grid = /\.codingns-magpie-quota-grid\{([^}]*)\}/u.exec(markup)?.[1] ?? ''
  assert.match(grid, /column-width:340px/u, 'the tile width drives how many columns fit')
  assert.match(grid, /column-gap:12px/u, 'columns keep the shared gap')
  assert.doesNotMatch(grid, /display:grid/u, 'the tile container is a multi-column flow, not a row grid')
  assert.doesNotMatch(grid, /grid-template-columns/u, 'no row-based column template')

  const card = /\.codingns-magpie-quota-card\{display:inline-block[^}]*\}/u.exec(markup)?.[0] ?? ''
  assert.match(card, /width:100%/u, 'a tile fills its column')
  assert.match(card, /break-inside:avoid/u, 'a tile is never split across two columns')
  assert.match(card, /page-break-inside:avoid/u, 'the same guard is provided for paged rendering')

  assert.match(markup, /\.codingns-magpie-quota-grid\{column-width:auto;column-count:1\}/u, 'phones fall back to a single column')
})

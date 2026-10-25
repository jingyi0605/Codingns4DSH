import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MagpieUsageService, parseMagpieQuotas } from '../src/host/cli-adapters/magpie-usage.js'
import { registerSubscriptionSlot } from '../src/client/subscription-slot.js'
import {
  classifyCheckin,
  describeCheckin,
  formatQuotaBalance,
  formatQuotaCredits,
  formatQuotaNumber,
  groupQuotasByProvider,
  localDayKey,
  parseQuotaBalance,
  quotaAccountLabel,
  quotaWindowAmount,
  quotaWindowRemaining,
  readWindowCreditBalance,
  resolveQuotaBalanceLabel,
  resolveQuotaCreditBalance,
} from '../src/client/features/subscription-quota-groups.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { MagpieQuota } from '../src/shared/contracts/subscription.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

function quota(overrides: Partial<MagpieQuota> & Pick<MagpieQuota, 'provider'>): MagpieQuota {
  return {
    provider: overrides.provider,
    name: overrides.name ?? 'WorkBuddy',
    kind: null,
    user: null,
    plan: null,
    alias: null,
    balance: null,
    readAt: null,
    windows: [],
    ...overrides,
  }
}

interface SlotView { render: (props?: unknown) => unknown }

type Element = { readonly type?: unknown; readonly props?: Record<string, unknown> }

function walkElements(node: unknown, visit: (element: Element) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  const element = node as Element
  visit(element)
  walkElements(element.props?.children, visit)
}

function findElement(node: unknown, predicate: (props: Record<string, unknown>) => boolean): Element | null {
  let found: Element | null = null
  walkElements(node, (element) => {
    if (found === null && element.props !== undefined && predicate(element.props)) found = element
  })
  return found
}

/** 弹层内容由函数组件渲染，元素树里只有它的宿主元素；这里手动展开一次。 */
function renderPopoverContent(node: unknown): unknown {
  let content: unknown = null
  walkElements(node, (element) => {
    if (content === null && typeof element.type === 'function') {
      content = (element.type as (props: unknown) => unknown)(element.props)
    }
  })
  return content
}

/**
 * 打开订阅弹层并切到「路由/配额」页签，返回该页签展开后的内容树。
 *
 * 沿用仓库既有写法：点击后再次调用 `render()` 让状态反映到树上；配额分组只在
 * 「路由/配额」页签内渲染。
 */
async function openQuotaTab(view: SlotView): Promise<unknown> {
  let trigger: Element | null = null
  for (let attempt = 0; attempt < 24; attempt++) {
    await setImmediate()
    trigger = findElement(view.render(), (props) => props.className === 'codingns4dsh-subscription-trigger')
    if (trigger !== null) break
  }
  assert.ok(trigger, 'the subscription trigger should render once the snapshot arrives')
  ;(trigger.props!.onClick as () => void)()

  const popover = renderPopoverContent(view.render())
  const tab = findElement(popover, (props) => props.id === 'codingns4dsh-magpie-tab-route')
  assert.ok(tab, 'the popover should expose the route/quota tab')
  ;(tab.props!.onClick as () => void)()
  // 打开页签会补发一次带路由的读取；这一次调用的返回值仍是旧树，
  // 必须让状态刷新后重新展开弹层内容组件，才能看到带配额的页签。
  for (let attempt = 0; attempt < 24; attempt++) {
    await setImmediate()
    view.render()
    const content = renderPopoverContent(view.render())
    if (findElement(content, (props) => props.className === 'codingns4dsh-quota-group-toggle') !== null
      || findElement(content, (props) => typeof props.style === 'object' && props.style !== null) !== null) {
      const groups = findElement(content, (props) => props.className === 'codingns4dsh-quota-group-toggle')
      if (groups !== null) return content
    }
  }
  return renderPopoverContent(view.render())
}

/**
 * 取元素树里的全部可见文本，用来断言呈现给用户的内容。
 *
 * 用 `renderToStaticMarkup` 而不是手工展开函数组件：弹层内容里已经出现自带 Hook 的
 * 子组件（如「查看请求」），手工调用会脱离 React 的 dispatcher 直接抛错。
 */
function textOf(node: unknown): string {
  const html = renderToStaticMarkup(node as never)
  return html
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
}

test('同一厂商的多个账号归为一组，并保持上游顺序', () => {
  const groups = groupQuotasByProvider([
    quota({ provider: 'workbuddy', user: 'jackson' }),
    quota({ provider: 'workbuddy', user: '燕子' }),
    quota({ provider: 'codex', name: 'Codex', user: 'me@example.com' }),
    quota({ provider: 'workbuddy', user: '白云5' }),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.provider, 'workbuddy')
  assert.deepEqual(groups[0]?.accounts.map((account) => account.user), ['jackson', '燕子', '白云5'])
  assert.equal(groups[1]?.provider, 'codex')
  assert.equal(groups[1]?.accounts.length, 1)
})

test('组内有活动账号时提到首位，但不改动其它账号的相对顺序', () => {
  const groups = groupQuotasByProvider([
    quota({ provider: 'workbuddy', user: '燕子' }),
    quota({ provider: 'workbuddy', user: '白云5', active: true }),
    quota({ provider: 'workbuddy', user: '薛定谔的杰' }),
  ])
  assert.deepEqual(groups[0]?.accounts.map((account) => account.user), ['白云5', '燕子', '薛定谔的杰'])
  assert.equal(groups[0]?.hasActive, true)
})

test('分组不把 WorkBuddy 与 WorkBuddy AI 合并，并跳过空 provider', () => {
  const groups = groupQuotasByProvider([
    quota({ provider: 'workbuddy' }),
    quota({ provider: 'workbuddy-ai', name: 'WorkBuddy AI' }),
    quota({ provider: '   ' }),
  ])
  assert.deepEqual(groups.map((group) => group.provider), ['workbuddy', 'workbuddy-ai'])
})

test('账号显示名优先别名，其次账号，最后厂商名', () => {
  assert.equal(quotaAccountLabel(quota({ provider: 'workbuddy', alias: '个人03', user: '白云5' }), 'WorkBuddy'), '个人03')
  assert.equal(quotaAccountLabel(quota({ provider: 'workbuddy', user: '白云5' }), 'WorkBuddy'), '白云5')
  assert.equal(quotaAccountLabel(quota({ provider: 'workbuddy', name: '' }), 'WorkBuddy'), 'WorkBuddy')
})

test('窗口余量在上游只给 used 时反推，display 与 amount/limit 二选一', () => {
  assert.equal(quotaWindowRemaining({ name: 'Credits', usedPercent: 5.33, remainingPercent: null, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }), 94.67)
  assert.equal(quotaWindowAmount({ name: 'Credits', usedPercent: null, remainingPercent: null, resetsAt: null, display: '127.91 / 2400', amount: 127.91, limit: 2400, unit: 'credits', holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }), '127.91 / 2400')
  assert.equal(quotaWindowAmount({ name: 'Credits', usedPercent: null, remainingPercent: null, resetsAt: null, display: null, amount: 128.84, limit: 2400, unit: 'credits', holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }), '128.84 / 2400 credits')
  assert.equal(quotaWindowAmount({ name: 'Credits', usedPercent: null, remainingPercent: null, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }), null)
})

test('余额文本区分金额与积分，不把积分猜成货币', () => {
  assert.equal(formatQuotaBalance(parseQuotaBalance('$74.40')!), '$74.40')
  assert.equal(parseQuotaBalance('$74.40')?.money, true)
  assert.equal(formatQuotaBalance(parseQuotaBalance('12.5 USD')!), '$12.50')
  assert.equal(formatQuotaBalance(parseQuotaBalance('€3')!), '€3.00')
  // 只有币种符号才能确定是金额；裸小数视为单位未知，不猜美元。
  assert.equal(parseQuotaBalance('69643.12')?.money, false)
  assert.equal(formatQuotaBalance(parseQuotaBalance('CNY 8.126')!), '¥8.13')
  // Codex 的 credits 不是金额：原样展示，不会变成 $69643.12
  const credits = parseQuotaBalance('69643.12 credits')
  assert.equal(credits?.money, false)
  assert.equal(credits?.unit, 'credits')
  assert.equal(credits?.amount, 69643.12)
  // 状态词与空值不产生余额
  assert.equal(parseQuotaBalance('available'), null)
  assert.equal(parseQuotaBalance(null), null)
  assert.equal(parseQuotaBalance('  '), null)
})

test('底部栏余额优先取有金额的账号，零余额不参与', () => {
  assert.equal(resolveQuotaBalanceLabel([quota({ provider: 'newapi', balance: '$74.40' })]), '$74.40')
  assert.equal(resolveQuotaBalanceLabel([
    quota({ provider: 'codex', balance: '69643.12 credits' }),
    quota({ provider: 'newapi', balance: '$74.40' }),
  ]), '$74.40', 'a balance string alone is not a currency balance')
  // 只有 credits 文本、没有任何积分窗口时，仍不是金额。
  assert.equal(resolveQuotaBalanceLabel([quota({ provider: 'codex', balance: '69643.12 credits' })]), null)
  assert.equal(resolveQuotaBalanceLabel([
    quota({ provider: 'newapi', user: 'first', balance: '$1.00' }),
    quota({ provider: 'newapi', user: 'active', balance: '$2.50', active: true }),
  ]), '$2.50', 'the account this session used wins')
  assert.equal(resolveQuotaBalanceLabel([quota({ provider: 'newapi', balance: '$0.00' })]), null)
  assert.equal(resolveQuotaBalanceLabel([quota({ provider: 'codex', balance: '100000 credits' })]), null)
  assert.equal(resolveQuotaBalanceLabel(undefined), null, 'older hosts omit quotas entirely')
})

/** 只按积分计量、没有百分比的窗口（WorkBuddy 的 `0 / 350`）。 */
function creditWindow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Credits', usedPercent: null, remainingPercent: null, resetsAt: null, display: null,
    amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null,
    ...overrides,
  }
}

test('积分窗口按数量读出余额，普通百分比窗口不参与', () => {
  const wb = resolveQuotaCreditBalance(quota({
    provider: 'workbuddy-ai',
    windows: [creditWindow({ display: '0 / 350', amount: 0, limit: 350, unit: 'credits', usedPercent: 100, remainingPercent: 0 })],
  }))
  assert.deepEqual(wb, { remaining: 0, limit: 350, unit: 'credits', display: '0 / 350' })
  // 上游只给上限与已用百分比时，用百分比还原剩余数量。
  const restored = resolveQuotaCreditBalance(quota({
    provider: 'workbuddy',
    windows: [creditWindow({ name: 'Credits', limit: 2400, amount: 223.12, unit: 'credits' })],
  }))
  assert.equal(restored?.remaining, 223.12)
  assert.equal(restored?.limit, 2400)
  // 5 hours / 7 days 这类窗口是百分比，不是积分。
  assert.equal(resolveQuotaCreditBalance(quota({
    provider: 'codex',
    windows: [creditWindow({ name: '5 hours', usedPercent: 2, remainingPercent: 98 })],
  })), null)
  assert.equal(readWindowCreditBalance(creditWindow({ name: 'Credits', limit: 130, remainingPercent: 100 }))?.remaining, 130)
  assert.equal(readWindowCreditBalance(creditWindow({ name: 'Weekly', remainingPercent: 80 })), null)
})

test('积分展示优先照抄上游 display，缺失时自己拼剩余与上限', () => {
  assert.equal(formatQuotaCredits({ remaining: 0, limit: 350, unit: 'credits', display: '0 / 350' }), '0 / 350')
  assert.equal(formatQuotaCredits({ remaining: 223.12, limit: 2400, unit: 'credits', display: null }), '223.12 / 2400 credits')
  assert.equal(formatQuotaCredits({ remaining: 130, limit: 130, unit: '积分', display: '  ' }), '130 / 130 积分')
})

test('没有金额时底部栏退回积分余额，零余额与状态词仍然不显示', () => {
  const creditsOnly = quota({
    provider: 'workbuddy',
    windows: [creditWindow({ name: 'Credits', amount: 223.12, limit: 2400, unit: 'credits', display: '223.12 / 2400' })],
  })
  assert.equal(resolveQuotaBalanceLabel([creditsOnly]), '223.12')
  // 金额优先于积分。
  assert.equal(resolveQuotaBalanceLabel([quota({ provider: 'newapi', balance: '$74.40', windows: [creditWindow({ amount: 5, limit: 10, unit: 'credits' })] })]), '$74.40')
  // 积分为 0 时没有可展示的余额。
  assert.equal(resolveQuotaBalanceLabel([quota({
    provider: 'workbuddy-ai',
    windows: [creditWindow({ display: '0 / 350', amount: 0, limit: 350, unit: 'credits', remainingPercent: 0 })],
  })]), null)
})

test('整数与小数按两位收敛显示，不使用指数记法', () => {
  assert.equal(formatQuotaNumber(2400), '2400')
  assert.equal(formatQuotaNumber(127.905), '127.91')
  assert.equal(formatQuotaNumber(Number.NaN), '--')
})

test('签到状态只把 claimed/done 视为成功，未知枚举不算成功', () => {
  const today = '2026-10-23'
  const base = { provider: 'workbuddy', checkins: true }
  assert.equal(classifyCheckin(quota({ ...base, checkin: { day: today, at: null, outcome: 'claimed', credit: 100, streak: 5 } }), today), 'claimed')
  assert.equal(classifyCheckin(quota({ ...base, checkin: { day: today, at: null, outcome: 'done', credit: null, streak: null } }), today), 'claimed')
  assert.equal(classifyCheckin(quota({ ...base, checkin: { day: today, at: null, outcome: 'captcha', credit: null, streak: null } }), today), 'captcha')
  assert.equal(classifyCheckin(quota({ ...base, checkin: { day: today, at: null, outcome: 'something-new', credit: null, streak: null } }), today), 'unknown')
  // 昨天的成功记录不能当成今天已签到
  assert.equal(classifyCheckin(quota({ ...base, checkin: { day: '2026-10-22', at: null, outcome: 'claimed', credit: 100, streak: 4 } }), today), 'pending')
})

test('签到文案区分成功、待签到与失败，并遵守同一天判定', () => {
  const t = resolveCodingNsTranslator(undefined)
  assert.match(describeCheckin('claimed', { day: '2026-10-23', at: null, outcome: 'claimed', credit: 100, streak: 5 }, t), /\+100.*5/u)
  assert.equal(describeCheckin('pending', null, t), '今日尚未签到')
  assert.equal(describeCheckin('failed', null, t), '签到失败')
})

test('localDayKey 用本地时区生成与上游一致的日期', () => {
  const date = new Date(2026, 9, 23, 15, 30)
  assert.equal(localDayKey(date.getTime()), '2026-10-23')
  assert.equal(localDayKey(new Date(2026, 0, 5, 0, 1).getTime()), '2026-01-05')
})

test('parseMagpieQuotas 保留签到、每日消耗、失败原因与重置卡字段', () => {
  const parsed = parseMagpieQuotas([
    {
      provider: 'workbuddy',
      name: 'WorkBuddy',
      user: 'Jackson Zhang',
      alias: '个人01',
      plan: 'Free',
      windows: [{ name: 'Credits', used: 5.33, display: '127.91 / 2400', amount: 127.91, limit: 2400, unit: 'credits', runsOut: 1500, runsOutAt: '2026-11-20T12:26:08Z' }],
      daily: { since: '2026-10-20', days: [{ day: '2026-10-20', used: 35.71 }, { day: '2026-10-23', used: 53.78 }] },
      checkins: true,
      checkin: { user: 'Jackson Zhang', day: '2026-10-23', at: '2026-10-23T00:00:19.658694+08:00', outcome: 'claimed', credit: 100, streak: 5 },
      error: 'Unauthorized',
      until: '2026-11-10T12:54:08Z',
      renew: 'auto',
      credits: '69643.12 credits',
      resets: { count: 2, until: '2026-11-01T00:00:00Z', each: [{ window: 'weekly', until: '2026-11-01T00:00:00Z' }], byWindow: false },
    },
  ])
  assert.ok(parsed !== null)
  const account = parsed[0]!
  assert.equal(account.error, 'Unauthorized')
  assert.equal(account.until, '2026-11-10T12:54:08Z')
  assert.equal(account.renew, 'auto')
  assert.equal(account.credits, '69643.12 credits')
  assert.equal(account.checkins, true)
  assert.deepEqual(account.checkin, {
    day: '2026-10-23',
    at: '2026-10-23T00:00:19.658694+08:00',
    outcome: 'claimed',
    credit: 100,
    streak: 5,
  })
  assert.deepEqual(account.daily, {
    since: '2026-10-20',
    days: [{ day: '2026-10-20', used: 35.71 }, { day: '2026-10-23', used: 53.78 }],
  })
  assert.equal(account.windows[0]?.runsOut, 1500)
  assert.equal(account.windows[0]?.runsOutAt, '2026-11-20T12:26:08Z')
  assert.equal(account.resets?.count, 2)
  assert.equal(account.resets?.byWindow, false)
  assert.deepEqual(account.resets?.each, [{ window: 'weekly', until: '2026-11-01T00:00:00Z' }])
})

test('parseMagpieQuotas 对缺失的新字段保持 undefined，旧版上游不受影响', () => {
  const parsed = parseMagpieQuotas([{ provider: 'codex', name: 'Codex', windows: [] }])
  assert.ok(parsed !== null)
  const account = parsed[0]!
  assert.equal(account.checkin, undefined)
  assert.equal(account.checkins, undefined)
  assert.equal(account.daily, undefined)
  assert.equal(account.resets, undefined)
  assert.equal(account.error, null)
})

test('会话快照严格区分本会话账号与同厂商的其它账号', async () => {
  const service = new MagpieUsageService({
    readModels: async () => { throw new Error('usage reads must not call the Magpie CLI') },
    readVersion: async () => { throw new Error('usage reads must not check the Magpie CLI version') },
    webApi: {
      async requestJson(path: string): Promise<unknown> {
        if (path.startsWith('/api/usage?')) {
          return { sessions: [{ agent: 'claude', id: 'provider-session', input: 10, output: 5, cache_read: 0, cache_write: 0, cost: 0.001 }] }
        }
        if (path === '/api/usage/quotas') {
          return [
            { provider: 'workbuddy', name: 'WorkBuddy', user: '燕子', windows: [] },
            { provider: 'workbuddy', name: 'WorkBuddy', user: '白云5', windows: [{ name: 'Credits', used: 5, limit: 2400, unit: 'credits' }] },
            { provider: 'workbuddy', name: 'WorkBuddy', user: '薛定谔的杰', windows: [] },
          ]
        }
        if (path.startsWith('/api/usage/requests')) {
          // 路由行的 `provider` 直接决定上游厂商；`providerAccount` 决定活动账号。
          return {
            rows: [{
              agent: 'claude',
              session: 'provider-session',
              provider: 'workbuddy',
              providerAccount: '白云5',
              model: 'deepseek-v4.1-flash',
              status: 200,
              t: new Date().toISOString(),
            }],
          }
        }
        return {}
      },
    },
  })
  // DSH 会话 ID 与 Provider 会话 ID 相同时会被视为无效身份，必须用两个不同的 ID。
  const snapshot = await service.read(
    { adapterId: 'claude-code', modelId: 'auto/deepseek-v4.1-flash', providerSessionId: 'provider-session' },
    undefined,
    true,
    'dsh-session',
  )
  assert.ok(snapshot !== null)
  // 本会话的配额只包含真正用过的账号，绝不把同厂商的其它账号算进来。
  assert.deepEqual((snapshot.quotas ?? []).map((item) => item.user), ['白云5'])
  assert.deepEqual((snapshot.quotas ?? []).map((item) => item.active === true), [true])
  // 同厂商其它账号单独下发，供分组展示，但不参与本会话余量。
  assert.deepEqual((snapshot.providerAccounts ?? []).map((item) => item.user), ['燕子', '薛定谔的杰'])
  assert.deepEqual((snapshot.providerAccounts ?? []).map((item) => item.active === true), [false, false])
})

/** 构造会话级 Magpie 快照响应，配额的账号来自 `accounts`。 */
function magpieSlotRpc(accounts: (includeRoute: boolean) => unknown, routeAccount: string | null, sessionName?: string) {
  return {
    call: async (_channel: string, method: string, payload: unknown) => {
      if (method.endsWith('/session/get')) {
        return { ok: true, value: { adapterId: 'claude-code', modelId: 'auto/deepseek-v4.1-flash', providerSessionId: 'provider-session' } }
      }
      assert.ok(method.endsWith('/subscription'))
      const includeRoute = (payload as { includeRoute?: boolean }).includeRoute === true
      return {
        ok: true,
        value: {
          providerUsage: null,
          magpie: {
            agent: 'claude', modelId: 'auto/deepseek-v4.1-flash', capturedAt: new Date().toISOString(), usageStatus: 'available',
            aggregate: { calls: 1, errors: 0, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
            sessionId: 'provider-session',
            ...(sessionName === undefined ? {} : { sessionName }),
            session: { id: 'provider-session', agent: 'claude', calls: 1, errors: 0, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
            routeStatus: includeRoute ? 'available' : 'not-requested',
            route: includeRoute ? {
              asked: 'auto/deepseek-v4.1-flash', group: null, rule: null, model: 'workbuddy/deepseek-v4.1-flash', effort: null,
              tries: [], done: true, status: '200', served: 'deepseek-v4.1-flash', providerAccount: routeAccount,
            } : null,
            upstreamProvider: includeRoute ? 'workbuddy' : null,
            upstreamProviders: includeRoute ? ['workbuddy'] : [],
            quotaStatus: includeRoute ? 'available' : 'provider-unavailable',
            quotas: includeRoute ? accounts(true) : accounts(false),
          },
        },
      }
    },
  }
}

const multiAccountQuotas = [
  {
    provider: 'workbuddy', name: 'WorkBuddy', kind: null, user: '白云5', plan: 'Free', alias: '个人03', balance: null, readAt: null,
    active: true, checkins: true,
    checkin: { day: localDayKey(Date.now()), at: null, outcome: 'claimed', credit: 100, streak: 4 },
    windows: [{ name: 'Credits', usedPercent: 5, remainingPercent: 95, resetsAt: null, display: '127.91 / 2400', amount: 127.91, limit: 2400, unit: 'credits', holdsWhy: null, startsAt: null, runsOut: 1500, runsOutAt: null }],
  },
  {
    provider: 'workbuddy', name: 'WorkBuddy', kind: null, user: '燕子', plan: 'Free', alias: '个人02', balance: null, readAt: null,
    checkins: true, checkin: { day: '2026-01-01', at: null, outcome: 'claimed', credit: 100, streak: 3 },
    windows: [{ name: 'Credits', usedPercent: 90, remainingPercent: 10, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }],
  },
]

function registerSlot(t: { after: (fn: () => void) => void }) {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  return {
    slots,
    mount(rpc: unknown) {
      registerSubscriptionSlot(slots as never, rpc as never)
      assert.ok(component, 'the subscription slot should register a component')
      const view = createHookRenderer(component!, { rpc, sessionId: 'dsh-session' })
      t.after(() => view.dispose())
      return view
    },
  }
}



test('Magpie usage displays the session name and ID on separate rows', async (t) => {
  const { mount } = registerSlot(t)
  const view = mount(magpieSlotRpc(() => [], null, 'Analyze module implementation'))
  const trigger = await waitForTrigger(view)
  ;(trigger.props!.onClick as () => void)()
  const popover = renderPopoverContent(view.render())
  const identity = findElement(popover, (props) => {
    const children = props.children as Element[] | undefined
    return props.style !== null && typeof props.style === 'object'
      && (props.style as { display?: string }).display === 'grid'
      && Array.isArray(children) && children[1]?.type === 'code' && children[1].props?.children === 'provider-session'
  })
  assert.ok(identity, 'the session identity should contain the name row and the ID row')
  const [nameRow, idRow] = identity.props!.children as Element[]
  assert.equal((nameRow!.props!.style as { display: string }).display, 'flex')
  assert.equal((nameRow!.props!.children as Element[])[1]?.props?.children, 'Analyze module implementation')
  assert.equal(idRow!.props!.children, 'provider-session')
})

test('订阅弹层按厂商分组显示多账号，并只展开会话实际使用的账号', async (t) => {
  const { mount } = registerSlot(t)
  const view = mount(magpieSlotRpc(() => multiAccountQuotas, '白云5'))
  const quotaPanel = await openQuotaTab(view)
  const markup = textOf(quotaPanel)
  assert.match(markup, /WorkBuddy/u, 'the provider group is titled with its own name; got: ' + markup.slice(0, 400))
  assert.match(markup, /2 个账号/u, 'the group reports how many accounts it holds')
  assert.match(markup, /个人03/u, 'the session account is expanded')
  assert.match(markup, /使用中/u, 'the session account is marked as in use')
  assert.match(markup, /今日已签到/u, 'the check-in state comes from the upstream payload')
  assert.match(markup, /连续 4 天/u, 'the check-in streak is shown')
  // 未展开的账号只保留余量，不显示签到与别名明细
  const detail = markup.slice(0, 900)
  assert.doesNotMatch(markup, /个人02/u, 'collapsed accounts hide their alias row; got: ' + detail)
  assert.match(markup, /10%/u, 'collapsed accounts still show their remaining percentage')
})

test('订阅弹层展开后显示组内全部账号的明细与各自签到状态', async (t) => {
  const { mount } = registerSlot(t)
  const view = mount(magpieSlotRpc(() => multiAccountQuotas, '白云5'))
  const collapsedPanel = await openQuotaTab(view)
  const collapsed = findElement(collapsedPanel, (props) => props.className === 'codingns4dsh-quota-group-toggle')
  assert.ok(collapsed, 'a multi-account provider offers an expand control; panel: ' + JSON.stringify(collapsedPanel).slice(0, 400))
  assert.equal(collapsed.props?.['aria-expanded'], false)

  ;(collapsed.props?.onClick as () => void)()
  const expandedPanel = renderPopoverContent(view.render())
  const expanded = findElement(expandedPanel, (props) => props.className === 'codingns4dsh-quota-group-toggle')
  assert.equal(expanded?.props?.['aria-expanded'], true)

  const markup = textOf(expandedPanel)
  assert.match(markup, /个人02/u, 'expanded group shows every account alias')
  assert.match(markup, /个人03/u)
  // 第二个账号的签到记录停留在过去，必须显示"今日尚未签到"而不是沿用活动账号的状态
  assert.match(markup, /今日尚未签到/u)
})

/** 等待订阅入口出现并返回按钮元素；余额来自会话快照，不需要打开弹层。 */
async function waitForTrigger(view: SlotView): Promise<Element> {
  let trigger: Element | null = null
  for (let attempt = 0; attempt < 24; attempt++) {
    await setImmediate()
    trigger = findElement(view.render(), (props) => props.className === 'codingns4dsh-subscription-trigger')
    if (trigger !== null) break
  }
  if (trigger === null) throw new Error('the Magpie trigger should render once the snapshot arrives')
  // 挂载后还有一次带路由的续读（用于识别上游厂商）；渲染以最新快照为准。
  for (let attempt = 0; attempt < 8; attempt++) await setImmediate()
  return findElement(view.render(), (props) => props.className === 'codingns4dsh-subscription-trigger') ?? trigger
}

test('有额度窗口时入口显示百分比环，金额余额留在弹层里', async (t) => {
  const { mount } = registerSlot(t)
  const balanceQuotas = [{
    provider: 'newapi', name: 'newapi', kind: 'subscription', user: 'Codex-AiCode', plan: 'default', alias: null,
    balance: '$74.40', readAt: null, active: true,
    windows: [{ name: 'Credits', usedPercent: 20, remainingPercent: 80, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }],
  }]
  const view = mount(magpieSlotRpc(() => balanceQuotas, 'Codex-AiCode'))
  const trigger = await waitForTrigger(view)
  const markup = JSON.stringify(trigger.props?.children)
  assert.match(markup, /conic-gradient/u, 'the remaining percentage keeps the ring')
  assert.match(markup, /80/u, 'the ring shows the upstream remaining percentage')
  assert.doesNotMatch(textOf(trigger.props?.children), /74\.40/u, 'the folded entry stays a single readout')
})

test('Codex quota trigger derives the ring from used percentage even before route status resolves', async (t) => {
  const { mount } = registerSlot(t)
  const codexQuotas = [{
    provider: 'codex', name: 'Codex', kind: 'subscription', user: 'codex@example.com', plan: 'Plus', alias: null,
    balance: '69643.12 credits', readAt: null,
    windows: [{ name: '5 hours', usedPercent: 10, remainingPercent: null, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }],
  }]
  const view = mount(magpieSlotRpc(() => codexQuotas, 'codex@example.com'))
  const trigger = await waitForTrigger(view)
  const markup = JSON.stringify(trigger.props?.children)
  assert.match(markup, /conic-gradient/u, 'a detected Codex quota should keep the circular readout')
  assert.match(markup, /90/u, 'the ring should derive remaining quota from used percentage')
  assert.doesNotMatch(textOf(trigger.props?.children), /Magpie/u, 'the fallback label should not replace a detected quota')
})

test('只有积分额度时入口显示剩余积分而不是 0% 空环', async (t) => {
  const { mount } = registerSlot(t)
  const creditQuotas = [{
    provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: '白云5', plan: 'Free', alias: '个人03',
    balance: null, readAt: null, active: true,
    windows: [{ name: 'Credits', usedPercent: null, remainingPercent: null, resetsAt: null, display: '223.12 / 2400', amount: 223.12, limit: 2400, unit: 'credits', holdsWhy: null, startsAt: null, runsOut: null, runsOutAt: null }],
  }]
  const view = mount(magpieSlotRpc(() => creditQuotas, '白云5'))
  const trigger = await waitForTrigger(view)
  const markup = JSON.stringify(trigger.props?.children)
  assert.doesNotMatch(markup, /conic-gradient/u, 'a credits window has no meaningful percentage')
  assert.match(textOf(trigger.props?.children), /223\.12/u, 'the remaining credits are shown instead')
})


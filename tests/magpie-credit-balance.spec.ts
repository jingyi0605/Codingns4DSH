import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { registerSubscriptionSlot } from '../src/client/subscription-slot.js'
import {
  formatQuotaBalance,
  formatQuotaCredits,
  formatQuotaNumber,
  parseQuotaBalance,
  readWindowCreditBalance,
  resolveQuotaBalanceLabel,
  resolveQuotaCreditBalance,
} from '../src/client/features/subscription-quota-groups.js'
import type { MagpieQuota } from '../src/shared/contracts/subscription.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

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

type Element = { readonly type?: unknown; readonly props?: Record<string, unknown> }

function findElement(node: unknown, predicate: (props: Record<string, unknown>) => boolean): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as Element
  if (element.props !== undefined && predicate(element.props)) return element
  return findElement(element.props?.children, predicate)
}

/** 取元素树里的全部可见文本，用来断言呈现给用户的内容。 */
function textOf(node: unknown): string {
  const parts: string[] = []
  const walk = (current: unknown): void => {
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current))
      return
    }
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    walk((current as Element).props?.children)
  }
  walk(node)
  return parts.join(' ')
}

/** 构造会话级 Magpie 快照响应，配额的账号来自 `accounts`。 */
function magpieSlotRpc(accounts: (includeRoute: boolean) => unknown, routeAccount: string | null) {
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


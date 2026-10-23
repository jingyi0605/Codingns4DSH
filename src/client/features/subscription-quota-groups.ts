import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { MagpieQuota, MagpieQuotaCheckin, MagpieQuotaWindow } from '../../shared/contracts/subscription.js'
import type { CodingNsTranslator } from '../locale.js'
import { MagpieProviderLogo } from './magpie-provider-logo.js'
import { uiFontSize } from '../font-scale.js'

/**
 * 同一厂商的多个账号在订阅弹层里归成一组。
 *
 * 分组键只用上游的 `provider`，不合并 `plan` 或显示名：WorkBuddy 与 WorkBuddy AI 是
 * 两个独立产品，账号之间也不共享额度，按显示名合并会把不同账户体系的余额混在一起。
 */
export interface SubscriptionQuotaGroup {
  readonly provider: string
  readonly name: string
  readonly icon?: string
  readonly logoDataUrl?: string
  /** 该厂商的账号；会话实际使用过的账号排在第一位。 */
  readonly accounts: readonly MagpieQuota[]
  /** 组内是否有本会话确认使用过的账号。 */
  readonly hasActive: boolean
}

/**
 * 按厂商分组，保持上游首次出现的顺序。
 *
 * 组内把 `active` 账号提到最前，其余沿用上游顺序；没有 `active` 标记时完全保持原顺序，
 * 不对"哪个账号正在使用"做任何猜测。
 */
export function groupQuotasByProvider(quotas: readonly MagpieQuota[]): readonly SubscriptionQuotaGroup[] {
  const groups = new Map<string, MagpieQuota[]>()
  for (const quota of quotas) {
    const provider = quota.provider.trim()
    if (provider === '') continue
    const existing = groups.get(provider)
    if (existing === undefined) groups.set(provider, [quota])
    else existing.push(quota)
  }
  return [...groups.entries()].map(([provider, accounts]) => {
    const first = accounts[0]!
    const ordered = [...accounts.filter((quota) => quota.active === true), ...accounts.filter((quota) => quota.active !== true)]
    return {
      provider,
      name: first.name,
      ...(first.icon === undefined ? {} : { icon: first.icon }),
      ...(first.logoDataUrl === undefined ? {} : { logoDataUrl: first.logoDataUrl }),
      accounts: ordered,
      hasActive: ordered.some((quota) => quota.active === true),
    }
  })
}

/** 账号在组内的显示名：用户起的别名优先，其次上游账号名，最后回退到厂商名。 */
export function quotaAccountLabel(quota: MagpieQuota, fallback: string): string {
  return quota.alias?.trim() || quota.user?.trim() || quota.name.trim() || fallback
}

/** 单个窗口的剩余百分比；上游只给 `used` 时反推，两者都没有时返回 null。 */
export function quotaWindowRemaining(window: MagpieQuotaWindow): number | null {
  if (window.remainingPercent !== null) return window.remainingPercent
  if (window.usedPercent !== null) return 100 - window.usedPercent
  return null
}

/** 窗口余量的可读数值：优先上游的 `display`，其次 `amount / limit unit`。 */
export function quotaWindowAmount(window: MagpieQuotaWindow): string | null {
  if (window.display !== null) return window.display
  if (window.amount === null || window.limit === null) return null
  const unit = window.unit === null ? '' : ` ${window.unit}`
  return `${formatQuotaNumber(window.amount)} / ${formatQuotaNumber(window.limit)}${unit}`
}

/** 四舍五入到两位小数；整数不补 `.00`，避免 2400 显示成 2400.00。 */
export function formatQuotaNumber(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return String(Math.round(value * 100) / 100)
}

export interface QuotaBalance {
  /** 上游原始 `balance` 文本（如 `$74.40`、`12.5 USD`）。 */
  readonly raw: string
  /** 规范化后的币种符号：`$`、`€`、`¥`、`£`、`₹`、`₩`、`₽` 或大写的三位币种代码。 */
  readonly unit: string
  readonly amount: number
  /**
   * 是否为可读金额：带币种符号、小数或币种代码的余额才作为金额展示。
   * 纯整数或 `available` 这类状态词不是金额，不能猜成美元。
   */
  readonly money: boolean
}

/**
 * 解析 Magpie 账号余额文本。
 *
 * Magpie 的 `balance` 是厂商原样文本（Codex 为 `69643.12 credits`，New-API 为
 * `$74.40`），既可能是金额也可能是积分。这里按明确出现的币种符号与小数位识别
 * 金额，`credits` 之类的单位保留原样，避免把积分当成美元。
 */
export function parseQuotaBalance(value: string | null | undefined): QuotaBalance | null {
  const raw = value?.trim() ?? ''
  if (raw === '') return null
  // 显式币种符号优先，允许符号在数值前或后（`€1.50` / `1.50 €`）。
  const parsed = /^(?<prefix>\D*?)\s*(?<amount>\d[\d,]*(?:\.\d+)?)\s*(?<suffix>.*)$/u.exec(raw)
  if (parsed === null) return null
  const digits = parsed.groups?.prefix ?? ''
  const amountText = parsed.groups?.amount ?? ''
  const trailer = (parsed.groups?.suffix ?? '').trim()
  const amount = Number(amountText.replace(/,/gu, ''))
  if (!Number.isFinite(amount)) return null
  // 币种符号只看前缀与后缀的首个词：`69643.12 credits` 的 `credits` 是单位，不是币种。
  const firstToken = (text: string): string => (text.trim().split(/\s+/u)[0] ?? '').toUpperCase()
  const symbol = QUOTA_CURRENCY_SYMBOLS.get(firstToken(digits))
    ?? QUOTA_CURRENCY_SYMBOLS.get(firstToken(trailer))
  const code = /^[A-Z]{3}$/u.test(firstToken(trailer)) ? firstToken(trailer) : null
  const unit = symbol ?? code ?? (trailer === '' ? '' : trailer)
  return {
    raw,
    unit,
    amount,
    // 只有带币种（符号或代码）的余额才是金额。裸小数也可能是积分，
    // 例如 `69643.12 credits` 不能显示成 `$69643.12`。
    money: symbol !== undefined || code !== null,
  }
}

const QUOTA_CURRENCY_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ['$', '$'],
  ['US$', '$'],
  ['USD', '$'],
  ['€', '€'],
  ['EUR', '€'],
  ['¥', '¥'],
  ['￥', '¥'],
  ['CNY', '¥'],
  ['RMB', '¥'],
  ['£', '£'],
  ['GBP', '£'],
  ['₹', '₹'],
  ['INR', '₹'],
  ['₩', '₩'],
  ['KRW', '₩'],
  ['₽', '₽'],
  ['RUB', '₽'],
])

/** 金额的展示文本：小数保留到两位，极小金额保留有效位而不是舍成 0.00。 */
export function formatQuotaBalance(balance: QuotaBalance): string {
  const amount = balance.amount
  const rounded = Number.isInteger(amount) && balance.unit === '' ? String(amount) : amount.toFixed(2)
  if (balance.unit === '') return rounded
  if (balance.unit === '$') return `$${rounded}`
  return `${balance.unit}${rounded}`
}

/**
 * 上游按积分（而非货币）计量时的余额。
 *
 * WorkBuddy、WorkBuddy AI 这类厂商只提供 `Credits` 窗口，`0 / 350` 就是全部余额，
 * 既没有金额 `balance` 也没有百分比可算（剩余量恒为 0%）。这里把这类"计数额度"
 * 单独读出来，让底部栏显示 `350` 而不是一个永远空着的 `0%` 环。
 */
export interface QuotaCreditBalance {
  /** 剩余可用的积分。 */
  readonly remaining: number
  /** 额度上限；上游只给百分比或总数时可能缺失。 */
  readonly limit: number | null
  /** 上游单位（`credits`、`points` 等）；只有窗口名时可退回窗口名。 */
  readonly unit: string
  /** 上游给出的展示原文（如 `0 / 350`），用于 tooltip 与弹层。 */
  readonly display: string | null
}

/** 窗口名里表示"按积分计量"的词；这些窗口的 `remaining` 才是人工可读的余额。 */
const QUOTA_CREDIT_UNIT_PATTERN = /credit|points|积分|点数/iu

/** 单个窗口是否按积分计量，以及它的余量读数；普通百分比窗口返回 null。 */
export function readWindowCreditBalance(window: MagpieQuotaWindow): QuotaCreditBalance | null {
  const unit = window.unit?.trim() ?? ''
  const named = QUOTA_CREDIT_UNIT_PATTERN.test(window.name)
  const typed = unit !== '' && QUOTA_CREDIT_UNIT_PATTERN.test(unit)
  if (!named && !typed) return null
  const unitLabel = unit !== '' ? unit : window.name.trim()
  // 上游按数量记账时，`amount` 就是剩余量（Magpie 契约：`amount of limit used`）。
  if (window.amount !== null && Number.isFinite(window.amount)) {
    const limit = window.limit !== null && Number.isFinite(window.limit) ? window.limit : null
    return { remaining: window.amount, limit, unit: unitLabel, display: window.display }
  }
  // 没有数量时上游给的是百分比：用百分比乘上限还原剩余量。
  const percent = quotaWindowRemaining(window)
  if (percent === null || window.limit === null || !Number.isFinite(window.limit)) return null
  return { remaining: (window.limit * percent) / 100, limit: window.limit, unit: unitLabel, display: window.display }
}

/**
 * 读取账号的积分余额。
 *
 * 只认带积分含义的窗口或单位，普通的百分比窗口（`5 hours`、`7 days`）不参与，
 * 避免把"剩余 73%"说成"73 积分"。
 */
export function resolveQuotaCreditBalance(quota: { readonly windows: readonly MagpieQuotaWindow[] }): QuotaCreditBalance | null {
  for (const window of quota.windows) {
    const credit = readWindowCreditBalance(window)
    if (credit !== null) return credit
  }
  return null
}

/**
 * 弹层里的积分文本：`剩余 / 上限 + 单位`。
 *
 * 只在窗口没有百分比时使用（百分比仍是更直接的读法）；上游给了 `0 / 350`
 * 这类 display 原文时优先照抄，避免自己再算一遍四舍五入。
 */
export function formatQuotaCredits(credits: QuotaCreditBalance): string {
  if (credits.display !== null && credits.display.trim() !== '') return credits.display.trim()
  const unit = credits.unit === '' ? '' : ` ${credits.unit}`
  return credits.limit === null
    ? `${formatQuotaNumber(credits.remaining)}${unit}`
    : `${formatQuotaNumber(credits.remaining)} / ${formatQuotaNumber(credits.limit)}${unit}`
}

/**
 * 底部栏触发按钮上要显示的余额文本。
 *
 * 优先展示金额余额（如 New-API 的 `$74.40`）；没有金额但上游按积分计量时展示积分
 * （如 WorkBuddy 的 `350`）。状态词之类的伪余额不显示，由圆形额度环承担。
 * 多个账号时展示会话实际使用的账号，否则取第一个有余额的账号。
 */
export function resolveQuotaBalanceLabel(quotas: readonly MagpieQuota[] | null | undefined): string | null {
  // 旧版 Host 或网关不可用时快照没有 `quotas` 字段，这里不能假设数组存在。
  const rows = quotas ?? []
  const ordered = [...rows.filter((quota) => quota.active === true), ...rows.filter((quota) => quota.active !== true)]
  for (const quota of ordered) {
    const balance = parseQuotaBalance(quota.balance)
    if (balance !== null && balance.money && balance.amount > 0) return formatQuotaBalance(balance)
  }
  for (const quota of ordered) {
    const credits = resolveQuotaCreditBalance(quota)
    if (credits !== null && credits.remaining > 0) return formatQuotaNumber(credits.remaining)
  }
  return null
}

/**
 * 签到状态的语义分类。
 *
 * 只把上游明确表示成功的 `claimed` / `done` 算作已签到；未知枚举按"未签到"处理，
 * 这样新厂商状态不会在界面上被当成成功。
 */
export type CheckinState = 'claimed' | 'failed' | 'ineligible' | 'inactive' | 'captcha' | 'own-app' | 'pending' | 'unknown'

export function classifyCheckin(quota: MagpieQuota, today: string): CheckinState {
  const checkin = quota.checkin ?? null
  if (checkin === null) return quota.checkins === true ? 'pending' : 'unknown'
  if (checkin.day !== null && checkin.day !== today) return quota.checkins === true ? 'pending' : 'unknown'
  switch (checkin.outcome) {
    case 'claimed':
    case 'done':
      return 'claimed'
    case 'failed':
      return 'failed'
    case 'ineligible':
      return 'ineligible'
    case 'inactive':
      return 'inactive'
    case 'captcha':
      return 'captcha'
    case 'own-app':
      return 'own-app'
    default:
      return 'unknown'
  }
}

/** 用本地时区算出"今天"，与上游的 `day` 字段比较时必须用同一时区。 */
export function localDayKey(nowMs: number): string {
  const date = new Date(nowMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 签到状态的本地化文案；参数为空对象时表示"今天还没有签到记录"。 */
export function describeCheckin(state: CheckinState, checkin: MagpieQuotaCheckin | null | undefined, t: CodingNsTranslator): string {
  switch (state) {
    case 'claimed':
      return t('usage.checkinClaimed', {
        credit: checkin?.credit === null || checkin?.credit === undefined ? '' : ` +${formatQuotaNumber(checkin.credit)}`,
        streak: checkin?.streak === null || checkin?.streak === undefined ? '' : t('usage.checkinStreak', { days: checkin.streak }),
      }).replace(/\s+/gu, ' ').trim()
    case 'failed':
      return t('usage.checkinFailed')
    case 'ineligible':
      return t('usage.checkinIneligible')
    case 'inactive':
      return t('usage.checkinInactive')
    case 'captcha':
      return t('usage.checkinCaptcha')
    case 'own-app':
      return t('usage.checkinOwnApp')
    case 'pending':
      return t('usage.checkinPending')
    default:
      return t('usage.checkinUnknown')
  }
}

/** 签到行的状态点：成功/待定/失败三种颜色语义。 */
function checkinTone(state: CheckinState): 'ok' | 'wait' | 'bad' {
  if (state === 'claimed') return 'ok'
  if (state === 'pending' || state === 'inactive') return 'wait'
  return 'bad'
}

const CHECKIN_TONE_COLORS: Record<'ok' | 'wait' | 'bad', string> = {
  ok: '#16a34a',
  wait: 'GrayText',
  bad: '#dc2626',
}

/** 每日消耗的迷你柱状图；没有按日数据时整块不渲染。 */
function createDailyBars(quota: MagpieQuota, t: CodingNsTranslator): ReactElement | null {
  const days = quota.daily?.days ?? []
  const values = days.map((day) => day.used).filter((value): value is number => value !== null)
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  return createElement('div', { style: { display: 'grid', gap: 4 } },
    createElement('div', { style: dailyBarsRowStyle, 'aria-hidden': true },
      ...values.map((value, index) => createElement('span', {
        key: index,
        style: {
          flex: 1,
          minWidth: 3,
          height: Math.max(2, Math.round((value / max) * 22)),
          borderRadius: 2,
          background: 'currentColor',
          opacity: 0.28 + 0.5 * (value / max),
        },
      })),
    ),
    createElement('span', { style: { fontSize: uiFontSize(11), color: 'GrayText' } },
      t('usage.quotaDailyTotal', { amount: formatQuotaNumber(values.reduce((sum, value) => sum + value, 0)) }),
    ),
  )
}

/** 重置卡明细：数量 + 最近到期的几张。 */
function createResetCards(quota: MagpieQuota, t: CodingNsTranslator): ReactElement | null {
  const resets = quota.resets
  if (resets === null || resets === undefined) return null
  const count = resets.count
  if (count === null && resets.fiveHour === null && resets.weekly === null && resets.each.length === 0) return null
  const head = resets.byWindow
    ? t('usage.resetCardsByWindow', { fiveHour: resets.fiveHour ?? 0, weekly: resets.weekly ?? 0 })
    : t('usage.resetCardsCount', { count: count ?? 0 })
  const expiries = resets.each
    .map((card) => card.until)
    .filter((until): until is string => until !== null)
    .sort()
  return createElement('div', { style: { display: 'grid', gap: 3 } },
    createElement('div', { style: quotaFooterRowStyle },
      createElement('span', undefined, t('usage.resetCardsLabel')),
      createElement('strong', undefined, head),
    ),
    expiries.slice(0, 3).map((until, index) => createElement('div', {
      key: `${until}-${index}`,
      style: { fontSize: uiFontSize(11), color: 'GrayText' },
    }, t('usage.resetCardsExpiresAt', { time: formatLocalTime(until) }))),
  )
}

/** 窗口的"按当前速度耗尽"提示；上游没给时整行不渲染。 */
function createRunsOutLine(window: MagpieQuotaWindow, t: CodingNsTranslator): ReactElement | null {
  const runsOutAt = window.runsOutAt?.trim()
  if (runsOutAt === undefined || runsOutAt === '') return null
  const at = Date.parse(runsOutAt)
  if (!Number.isFinite(at) || at <= Date.now()) return null
  return createElement('span', { style: { fontSize: uiFontSize(11), color: 'GrayText' } },
    t('usage.quotaRunsOut', {
      amount: window.runsOut === null ? '' : formatQuotaNumber(window.runsOut),
      time: formatLocalTime(runsOutAt),
    }).replace(/\s+/gu, ' ').trim(),
  )
}

export function formatLocalTime(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Date(time).toLocaleString()
}

/** 一个账号的详情块：窗口条、签到、重置卡、每日消耗与错误摘要。 */
export function createQuotaAccountBlock(quota: MagpieQuota, options: {
  readonly t: CodingNsTranslator
  readonly nowMs: number
  /** 组内账号数 > 1 时显示账号名，单账号时由组头承担。 */
  readonly showAccountName: boolean
  /** 折叠态只画进度条，不画签到、明细与每日用量。 */
  readonly compact: boolean
  readonly fallbackName: string
}): ReactElement {
  const { t, nowMs, showAccountName, compact, fallbackName } = options
  const checkinState = classifyCheckin(quota, localDayKey(nowMs))
  const balance = parseQuotaBalance(quota.balance)
  const hasWindows = quota.windows.length > 0
  // 金额余额是账户级信息：没有窗口（或窗口读失败）的账号也要显示，折叠态同样保留，
  // 否则 New-API 这类"只有余额、没有窗口"的账号在弹层里会看起来空无一物。
  const balanceRow = balance !== null
    && createElement('div', { style: quotaFooterRowStyle },
      createElement('span', undefined, t('usage.creditBalanceLabel')),
      createElement('strong', { title: balance.raw }, formatQuotaBalance(balance)),
    )
  return createElement('div', { style: accountBlockStyle },
    // 折叠账号只留窗口条（Magpie 原生的 "brief" 卡片也是这个读法）：
    // 账号名与套餐属于详情信息，展开后再显示。
    showAccountName && !compact && createElement('div', { style: accountNameRowStyle },
      createElement('span', { style: accountNameStyle, title: quota.user ?? undefined }, quotaAccountLabel(quota, fallbackName)),
      quota.user !== null && quota.alias !== null && createElement('span', { style: accountSecondaryStyle }, quota.user),
      quota.active === true && createElement('span', { style: activeBadgeStyle }, t('usage.quotaActiveAccount')),
      quota.plan !== null && createElement('span', { style: accountPlanStyle }, quota.plan),
    ),
    quota.error !== null && quota.error !== undefined && createElement('div', { style: quotaErrorStyle },
      t('usage.quotaReadFailed', { reason: quota.error }),
    ),
    quota.windows.length === 0
      ? quota.error === null || quota.error === undefined
        ? balanceRow ?? createElement('div', { style: { fontSize: uiFontSize(12), color: 'GrayText' } }, t('usage.magpieQuotaNoWindows'))
        : null
      : quota.windows.map((window, index) => {
          const remaining = quotaWindowRemaining(window)
          const amount = quotaWindowAmount(window)
          const runsOut = compact ? null : createRunsOutLine(window, t)
          return createElement('div', { key: `${window.name}-${index}`, style: quotaWindowRowStyle },
            createElement('div', { style: quotaFooterRowStyle },
              createElement('span', undefined, window.name),
              remaining === null
                ? amount !== null && createElement('span', undefined, amount)
                : createElement('strong', undefined, `${Math.round(remaining)}%`),
            ),
            remaining !== null && createElement('div', {
              role: 'progressbar',
              'aria-label': t('usage.magpieQuotaRemaining', { name: window.name, percent: String(Math.round(remaining)) }),
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(remaining),
              style: quotaBarStyle,
            },
              createElement('span', { style: { ...quotaBarFillStyle, width: `${Math.max(0, Math.min(100, remaining))}%` } }),
            ),
            compact ? null : createElement('div', { style: quotaWindowMetaStyle },
              amount !== null && remaining !== null && createElement('span', undefined, amount),
              window.resetsAt !== null && createElement('span', undefined, t('usage.magpieQuotaResets', { time: formatLocalTime(window.resetsAt) })),
            ),
            runsOut,
          )
        }),
    !compact && hasWindows && balanceRow,
    !compact && (quota.checkins === true || quota.checkin !== null && quota.checkin !== undefined) && createElement('div', { style: quotaFooterRowStyle },
      createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        createElement('span', { style: { ...checkinDotStyle, background: CHECKIN_TONE_COLORS[checkinTone(checkinState)] }, 'aria-hidden': true }),
        createElement('span', { style: { fontSize: uiFontSize(12), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, describeCheckin(checkinState, quota.checkin, t)),
      ),
    ),
    !compact && createResetCards(quota, t),
    !compact && quota.credits !== null && quota.credits !== undefined && createElement('div', { style: quotaFooterRowStyle },
      createElement('span', undefined, t('usage.creditBalanceLabel')),
      createElement('strong', undefined, quota.credits),
    ),
    !compact && quota.until !== null && quota.until !== undefined && createElement('div', { style: quotaFooterRowStyle },
      createElement('span', undefined, t('usage.quotaPlanUntil')),
      createElement('span', undefined, `${formatLocalTime(quota.until)}${quota.renew === null || quota.renew === undefined ? '' : ` · ${quota.renew}`}`),
    ),
    !compact && createDailyBars(quota, t),
  )
}

/** 厂商组头：图标、名称、账号数与被使用的账号。 */
export function createQuotaGroupHeader(input: {
  readonly group: SubscriptionQuotaGroup
  readonly t: CodingNsTranslator
  readonly expanded: boolean
  readonly onToggle: (() => void) | null
}): ReactElement {
  const { group, t, expanded, onToggle } = input
  const activeAccount = group.accounts.find((quota) => quota.active === true)
  const summary = activeAccount === undefined
    ? group.accounts[0]
    : activeAccount
  // 组头摘要：窗口余量优先；没有窗口时退回金额余额（New-API 类厂商只有余额）。
  const summaryBalance = summary === undefined ? null : parseQuotaBalance(summary.balance)
  const summaryLabel = summary !== undefined && summary.windows.length > 0
    ? summary.windows
      .map((window) => {
        const remaining = quotaWindowRemaining(window)
        return remaining === null ? null : `${Math.round(remaining)}%`
      })
      .filter((value): value is string => value !== null)
      .join(' · ')
    : summaryBalance === null ? '' : formatQuotaBalance(summaryBalance)
  return createElement('div', { style: groupHeaderStyle },
    createElement(MagpieProviderLogo, {
      identities: [group.provider, group.name],
      logoDataUrl: group.logoDataUrl,
      size: 22,
      className: 'codingns4dsh-quota-group-logo',
      fallback: 'none',
    }),
    createElement('strong', { style: { fontSize: uiFontSize(13), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.name || group.provider),
    group.accounts.length > 1 && createElement('span', { style: groupCountStyle }, t('usage.quotaGroupAccounts', { count: group.accounts.length })),
    summaryLabel !== '' && createElement('span', { style: groupSummaryStyle, title: summaryBalance?.raw }, summaryLabel),
    onToggle !== null && createElement('button', {
      type: 'button',
      className: 'codingns4dsh-quota-group-toggle',
      'aria-expanded': expanded,
      onClick: onToggle,
      title: expanded ? t('usage.quotaCollapseAccounts') : t('usage.quotaExpandAccounts'),
      'aria-label': expanded ? t('usage.quotaCollapseAccounts') : t('usage.quotaExpandAccounts'),
      style: groupToggleStyle,
    }, expanded ? '▾' : '▸'),
  )
}

const dailyBarsRowStyle = { display: 'flex', alignItems: 'flex-end', gap: 2, height: 22, color: 'GrayText' } as const
const accountBlockStyle = { display: 'grid', gap: 8, paddingTop: 6 } as const
const accountNameRowStyle = { display: 'flex', alignItems: 'baseline', gap: 7, fontSize: uiFontSize(12), minWidth: 0 } as const
const accountNameStyle = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } as const
const accountSecondaryStyle = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'GrayText' } as const
const accountPlanStyle = { marginLeft: 'auto', flex: 'none', color: 'GrayText' } as const
const activeBadgeStyle = {
  flex: 'none',
  padding: '1px 6px',
  borderRadius: 999,
  fontSize: uiFontSize(10),
  background: 'rgba(22,119,255,.12)',
  color: 'var(--dsw-alias-state-business-primary,#1677ff)',
} as const
const quotaErrorStyle = { fontSize: uiFontSize(11), color: '#dc2626' } as const
const quotaWindowRowStyle = { display: 'grid', gap: 4 } as const
const quotaFooterRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: uiFontSize(12),
  minWidth: 0,
} as const
const quotaWindowMetaStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: uiFontSize(11),
  color: 'GrayText',
  minWidth: 0,
} as const
const quotaBarStyle = {
  height: 6,
  borderRadius: 999,
  background: 'color-mix(in srgb, GrayText 22%, transparent)',
  overflow: 'hidden',
} as const
const quotaBarFillStyle = {
  display: 'block',
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, var(--dsw-alias-state-business-primary,#1677ff), color-mix(in srgb, var(--dsw-alias-state-business-primary,#1677ff) 55%, transparent))',
} as const
const checkinDotStyle = { flex: 'none', width: 7, height: 7, borderRadius: 999 } as const
const groupHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minWidth: 0,
  paddingBottom: 4,
} as const
const groupCountStyle = {
  flex: 'none',
  padding: '0 6px',
  borderRadius: 999,
  fontSize: uiFontSize(10),
  lineHeight: '16px',
  background: 'color-mix(in srgb, GrayText 16%, transparent)',
  color: 'GrayText',
} as const
const groupSummaryStyle = {
  marginLeft: 'auto',
  flex: 'none',
  fontSize: uiFontSize(11),
  color: 'GrayText',
  fontVariantNumeric: 'tabular-nums' as const,
} as const
const groupToggleStyle = {
  flex: 'none',
  display: 'inline-grid',
  placeItems: 'center',
  width: 20,
  height: 20,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'GrayText',
  cursor: 'pointer',
} as const


/**
 * 把 Magpie 用量页的配额行按厂商归组。
 *
 * 与订阅弹层共用同一个分组键（只有 `provider`），但保留各自的行类型：
 * 用量页还需要每行自己的 `daily` 明细与历史线。
 */
export function groupQuotaRowsByProvider<T extends {
  readonly provider: string
  readonly name: string
  readonly icon?: string
  readonly logoDataUrl?: string
  readonly user: string | null
}>(rows: readonly T[]): readonly { readonly provider: string; readonly name: string; readonly logoDataUrl?: string; readonly accounts: readonly T[] }[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const provider = row.provider.trim()
    if (provider === '') continue
    const existing = groups.get(provider)
    if (existing === undefined) groups.set(provider, [row])
    else existing.push(row)
  }
  return [...groups.entries()].map(([provider, accounts]) => {
    const first = accounts[0]!
    return {
      provider,
      name: first.name,
      ...(first.logoDataUrl === undefined ? {} : { logoDataUrl: first.logoDataUrl }),
      accounts,
    }
  })
}

/**
 * 余额解析只需要账号的 `balance` 与 `windows`。
 *
 * 订阅弹层的 `MagpieQuota` 与用量页的 `MagpieDashboardQuota` 窗口结构略有差异
 * （后者没有 `startsAt`），因此这里只约束实际用到的字段，两处共用同一个解析器。
 */
export interface QuotaAccountBalanceSource {
  readonly balance: string | null
  readonly windows: readonly MagpieQuotaWindowLike[]
}

/** 余额解析用到的窗口字段；其余字段（`startsAt`、`runsOut` 等）与本逻辑无关。 */
export interface MagpieQuotaWindowLike {
  readonly name: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly display: string | null
  readonly amount: number | null
  readonly limit: number | null
  readonly unit: string | null
}

/** 账号余额的读法：金额（`$74.14`）或计数额度（`2,077.75 / 2,400 积分`）。 */
export interface QuotaAccountBalance {
  /** 展示文本；金额已带币种符号。 */
  readonly text: string
  /** 是否为货币金额；用于决定是否按金额样式（等宽数字、较大字号）渲染。 */
  readonly money: boolean
  /** 上游原文，放在 tooltip 里供追溯。 */
  readonly raw: string
}

/**
 * 读取一个账号在"没有百分比可言"时的余额。
 *
 * 订阅页的额度卡过去只画百分比进度条，New-API（`$74.14`）、Sub2api（钱包余额
 * `$88018.15`）和按积分计量的 WorkBuddy（`2,077.75 / 2,400 积分`）这类账号
 * 就只剩一条空进度条，看不到真正的余额。这里按 Magpie 原生卡片的顺序取数：
 *
 * 1. 上游给出带币种的 `balance` → 直接就是金额；
 * 2. 某个窗口带明确的币种单位且给了 `amount / limit`（如 Command Code 的
 *    `$8.04 / $10.00`）→ 按币种拼成金额文本，符号与原生写法一样放在数值前；
 * 3. 账号上有按积分计量的窗口 → `剩余 / 上限 + 单位`；
 * 4. 只有 `amount / limit` 而没有币种 → 原样拼上单位。
 *
 * 都没有时返回 null，交给调用方显示"未报告额度上限"。
 */
export function resolveQuotaAccountBalance(quota: QuotaAccountBalanceSource): QuotaAccountBalance | null {
  const money = parseQuotaBalance(quota.balance)
  if (money !== null) return { text: formatQuotaBalance(money), money: money.money, raw: money.raw }
  // 先看显式币种窗口：Command Code 的窗口名是「积分」，但 `unit` 是 `$`，
  // 这时 `$8.04 / $10.00` 才是原生读法，不能被积分分支先截走。
  for (const window of quota.windows) {
    if (window.amount === null || window.limit === null) continue
    if (!Number.isFinite(window.amount) || !Number.isFinite(window.limit)) continue
    const symbol = QUOTA_CURRENCY_SYMBOLS.get((window.unit?.trim() ?? '').toUpperCase())
    if (symbol === undefined) continue
    // 币种符号按 Magpie 原生写法放在数值前（`$8.04 / $10.00`）。
    const text = `${symbol}${formatQuotaNumber(window.amount)} / ${symbol}${formatQuotaNumber(window.limit)}`
    return { text, money: true, raw: text }
  }
  const credits = resolveQuotaCreditBalance({ windows: quota.windows as readonly MagpieQuotaWindow[] })
  if (credits !== null) return { text: formatQuotaCredits(credits), money: false, raw: credits.display ?? formatQuotaCredits(credits) }
  for (const window of quota.windows) {
    if (window.amount === null || window.limit === null) continue
    if (!Number.isFinite(window.amount) || !Number.isFinite(window.limit)) continue
    const unit = window.unit?.trim() ?? ''
    const text = `${formatQuotaNumber(window.amount)} / ${formatQuotaNumber(window.limit)}${unit === '' ? '' : ` ${unit}`}`
    return { text, money: false, raw: text }
  }
  return null
}

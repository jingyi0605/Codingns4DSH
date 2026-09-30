import type { DshHostSettingsProvider } from '../dsh-capabilities/host/config-forms-adapter.js'

/**
 * Host 侧浏览器可见文案（局域网登录页、PWA manifest 与推送通知）。
 *
 * Host 没有 DSH Client 的 locale 运行时，因此这里提供最小的语言选择与词典：
 * - 由浏览器请求触发的页面按 `Accept-Language` 选择；
 * - 由 Host 主动推送的内容读取 DSH `locale` 设置命名空间的 `preference`；
 * - 两者都拿不到时回退 `zh`，与改造前的默认行为一致。
 */
export type HostLocale = 'zh' | 'en'

export type HostBrowserTextKey =
  | 'login.documentTitle'
  | 'login.captchaAlt'
  | 'login.captchaPlaceholder'
  | 'login.description'
  | 'login.username'
  | 'login.usernamePlaceholder'
  | 'login.password'
  | 'login.passwordPlaceholder'
  | 'login.submit'
  | 'login.required'
  | 'login.rateLimited'
  | 'login.badCaptcha'
  | 'login.badCredentials'
  | 'login.headerTooLarge'
  | 'manifest.description'
  | 'push.turnEndTitle'
  | 'push.turnEndBody'
  | 'push.waitingTitle'
  | 'push.waitingBody'
  | 'push.testTitle'
  | 'push.testBody'

const TEXT: Record<HostLocale, Record<HostBrowserTextKey, string>> = {
  en: {
    'login.documentTitle': 'DSH Web | Local sign-in',
    'login.captchaAlt': 'CAPTCHA image',
    'login.captchaPlaceholder': 'Enter the CAPTCHA',
    'login.description': 'Sign in to DSH Web with the local account configured on this machine.',
    'login.username': 'Username',
    'login.usernamePlaceholder': 'Enter the local username',
    'login.password': 'Password',
    'login.passwordPlaceholder': 'Enter the local password',
    'login.submit': 'Sign in to DSH Web',
    'login.required': 'Authentication required',
    'login.rateLimited': 'Too many sign-in attempts. Try again in {seconds} seconds.',
    'login.badCaptcha': 'Enter the correct CAPTCHA code.',
    'login.badCredentials': 'Incorrect username or password.',
    'login.headerTooLarge': 'Request headers too large',
    'manifest.description': 'DeepSeek Harness Web app (Codingns4DSH LAN entry)',
    'push.turnEndTitle': 'DSH session finished',
    'push.turnEndBody': 'Session {sessionId} finished its current turn.',
    'push.waitingTitle': 'DSH is waiting for your input',
    'push.waitingBody': 'Session {sessionId} is waiting for confirmation or an answer.',
    'push.testTitle': 'DSH test notification',
    'push.testBody': 'If you can see this notification, the push pipeline works.',
  },
  zh: {
    'login.documentTitle': 'DSH Web | 本地登录',
    'login.captchaAlt': '图形验证码',
    'login.captchaPlaceholder': '输入图形验证码',
    'login.description': '使用本机设置的本地账号进入 DSH Web。',
    'login.username': '用户名',
    'login.usernamePlaceholder': '输入本地用户名',
    'login.password': '密码',
    'login.passwordPlaceholder': '输入本地密码',
    'login.submit': '登录 DSH Web',
    'login.required': '需要登录',
    'login.rateLimited': '登录尝试过于频繁，请 {seconds} 秒后重试',
    'login.badCaptcha': '请输入正确的图形验证码',
    'login.badCredentials': '用户名或密码错误',
    'login.headerTooLarge': '请求头过大',
    'manifest.description': 'DeepSeek Harness Web 应用（Codingns4DSH 局域网入口）',
    'push.turnEndTitle': 'DSH 会话已完成',
    'push.turnEndBody': '会话 {sessionId} 已完成当前轮次。',
    'push.waitingTitle': 'DSH 等待你的输入',
    'push.waitingBody': '会话 {sessionId} 正在等待确认或回答。',
    'push.testTitle': 'DSH 测试通知',
    'push.testBody': '如果你看到这条通知，推送链路已经打通。',
  },
}

/** 取 Host 侧词条；插值规则与 Client 的 `{name}` 一致。 */
export function hostBrowserText(locale: HostLocale, key: HostBrowserTextKey, params?: Record<string, string | number>): string {
  const template = TEXT[locale][key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * 从 `Accept-Language` 选择 Host 支持的语言。
 *
 * 只认 DSH 支持的 zh/en；两种语言都不在候选里（或请求头缺失）时回退 `zh`，
 * 保持改造前中文登录页的默认行为。
 */
export function resolveAcceptLanguageLocale(header: string | undefined): HostLocale {
  if (header === undefined) return 'zh'
  for (const part of header.split(',')) {
    const tag = part.trim().split(';')[0]?.trim().toLowerCase() ?? ''
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('en')) return 'en'
  }
  return 'zh'
}

/**
 * 读取 DSH `locale` 设置命名空间里的显式语言偏好。
 *
 * 优先用 provider.get('locale')；不可用时回退 describe() 找到该 namespace 的当前值。
 * 未显式选择（字段缺失）返回 null，由调用方决定默认语言。
 */
export function readDshLocalePreference(provider: DshHostSettingsProvider | undefined): HostLocale | null {
  if (provider === undefined) return null
  const direct = asLocale(provider.get?.('locale'))
  if (direct !== null) return direct
  for (const descriptor of provider.describe?.() ?? []) {
    if (descriptor.ns !== 'locale') continue
    const value = asLocale(descriptor.value)
    if (value !== null) return value
  }
  return null
}

/** Host 主动推送时的语言：显式偏好优先，否则回退 `zh`。 */
export function resolveHostPushLocale(provider: DshHostSettingsProvider | undefined): HostLocale {
  return readDshLocalePreference(provider) ?? 'zh'
}

function asLocale(value: unknown): HostLocale | null {
  if (typeof value !== 'object' || value === null) return null
  const preference = (value as { readonly preference?: unknown }).preference
  return preference === 'zh' || preference === 'en' ? preference : null
}

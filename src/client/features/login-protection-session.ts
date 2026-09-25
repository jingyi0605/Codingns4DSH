/** 登录保护会话只放在当前浏览器标签页，关闭标签页即失效。 */
export const LOGIN_PROTECTION_SESSION_KEY = 'dsh-codingns.login-protection.relay-token'
export const LOGIN_PROTECTION_SESSION_EVENT = 'dsh-codingns-login-protection-session'
let memoryToken: string | undefined

export function readLoginProtectionSession(): string | undefined {
  try {
    const value = globalThis.sessionStorage.getItem(LOGIN_PROTECTION_SESSION_KEY)?.trim()
    return value === undefined || value === '' ? memoryToken : value
  } catch { return memoryToken }
}

export function writeLoginProtectionSession(token: string | undefined): void {
  memoryToken = token === undefined || token === '' ? undefined : token
  try {
    if (memoryToken === undefined) globalThis.sessionStorage.removeItem(LOGIN_PROTECTION_SESSION_KEY)
    else globalThis.sessionStorage.setItem(LOGIN_PROTECTION_SESSION_KEY, memoryToken)
  } catch { /* 浏览器隐私模式禁用存储时，使用当前页面内存中的票据。 */ }
  globalThis.dispatchEvent(new Event(LOGIN_PROTECTION_SESSION_EVENT))
}

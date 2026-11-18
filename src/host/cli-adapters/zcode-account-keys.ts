/**
 * ZCode 账号套餐的凭据键解析与「同家族复用」。
 *
 * 凭据键形如 `account-provider:coding-plan:account:<family>-<kind>:account:<accountIdentity>:api-key`。
 * ZCode 把「连接槽位名」和「订阅类型」分开记账：个人版套餐的 API Key 可能落在
 * `-team-coding-plan` 槽位里（本机实测如此），而额度挂在账号上，key 照常可用。
 * 因此当所选槽位没有自己的 key 时，允许在同一账号族内复用兄弟槽位的 key；
 * 家族内出现多个账号身份就说明这台机器上确实有多份凭据，此时不复用。
 *
 * 模型目录（zcode-driver）与用量/余额读取（zcode-provider-config）共用这一份实现，
 * 避免两处判定漂移。
 */

export interface ZcodeCodingPlanApiKeyEntry {
  /** 凭据文件里的键名。 */
  readonly key: string
  /** 是否来自同家族兄弟槽位。 */
  readonly borrowed: boolean
  /** 借用的来源槽位 providerId；自有时不存在。 */
  readonly sourceProviderId?: string
}

/** 从 `account:<family>-<kind>` 取出账号族；不是账号 Provider 时返回 null。 */
export function zcodeAccountFamily(providerId: string): string | null {
  // 族名不能假定只有小写字母数字：ZCode 另有 `zai_cn` 这类写法，令牌键
  // （`oauth:zai_cn:access_token`）就是按族名拼的，正则漏掉会把已连接的套餐
  // 判成未连接。后缀固定，前缀取最短匹配即可。
  const match = /^account:([A-Za-z0-9_-]+?)-(?:individual-coding-plan|team-coding-plan|start-plan|offpeak-idle-plan|highspeed-card)$/u.exec(providerId)
  return match?.[1] ?? null
}

/** 解析 `account-provider:coding-plan:<providerId>:account:<accountIdentity>:api-key`。 */
export function parseCodingPlanCredentialKey(key: string): { providerId: string; accountIdentity: string; family: string } | null {
  const prefix = 'account-provider:coding-plan:'
  const suffix = ':api-key'
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null
  const marker = ':account:'
  const body = key.slice(prefix.length, -suffix.length)
  const index = body.indexOf(marker)
  if (index <= 0) return null
  const providerId = body.slice(0, index)
  const family = zcodeAccountFamily(providerId)
  if (family === null) return null
  return { providerId, accountIdentity: decodeURIComponent(body.slice(index + marker.length)), family }
}

/** 该 Provider 自己槽位上的 coding-plan api-key 条目。 */
export function codingPlanApiKeyEntries(providerId: string, credentials: Record<string, any>): string[] {
  const prefix = `account-provider:coding-plan:${providerId}:account:`
  return Object.entries(credentials)
    .filter(([key, value]) => key.startsWith(prefix) && key.endsWith(':api-key')
      && typeof value === 'string' && value.trim() !== '')
    .map(([key]) => key)
}

/** 该 Provider 可用的 api-key 条目；自己槽位没有时，在同一账号族内复用兄弟槽位的 key。 */
export function accountProviderApiKeyEntry(providerId: string, credentials: Record<string, any>): ZcodeCodingPlanApiKeyEntry | null {
  const own = codingPlanApiKeyEntries(providerId, credentials)
  if (own.length > 0) return { key: own[0]!, borrowed: false }
  const family = zcodeAccountFamily(providerId)
  if (family === null) return null
  const siblings = Object.keys(credentials)
    .map(candidate => ({ candidate, parsed: parseCodingPlanCredentialKey(candidate) }))
    .filter(entry => entry.parsed !== null && entry.parsed.family === family && entry.parsed.providerId !== providerId
      && typeof credentials[entry.candidate] === 'string' && String(credentials[entry.candidate]).trim() !== '')
  if (siblings.length === 0) return null
  if (new Set(siblings.map(entry => entry.parsed!.accountIdentity)).size !== 1) return null
  return { key: siblings[0]!.candidate, borrowed: true, sourceProviderId: siblings[0]!.parsed!.providerId }
}

/** 是否存在该账号 Provider 可用（含同族复用）的 coding-plan api-key。 */
export function accountProviderApiKeyExists(providerId: string, credentials: Record<string, any>): boolean {
  return accountProviderApiKeyEntry(providerId, credentials) !== null
}

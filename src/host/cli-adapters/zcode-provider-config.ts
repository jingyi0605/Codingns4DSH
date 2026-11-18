import { decryptZcodeCredential } from './zcode-credentials.js'
import { accountProviderApiKeyEntry } from './zcode-account-keys.js'
import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveZCodeDesktopRuntime, type CodingNsDesktopAppRuntime } from './desktop-app-runtime.js'

export interface ZcodeProviderConfigOptions {
  readonly homeDirectory?: string
  readonly personalProviderConfigPath?: string
  readonly builtinProviderConfigPath?: string
  readonly credentialsPath?: string
  readonly credentialSecret?: string
  readonly runtime?: CodingNsDesktopAppRuntime | null
}

export interface ZcodeProviderConfig {
  readonly providerId: string
  readonly accessMode?: string
  /** 只有地址和凭据同时可用时才允许查询；原始凭据始终留在 Host。 */
  readonly source: { readonly baseUrl: string; readonly apiKey: string } | null
}

/**
 * 按原生顺序合并模板、内置 Provider 和个人覆盖规则。
 * ZCode 把地址存于 config.api，把密钥存于 config.access；不能递归猜测顶层字段。
 */
export function readZcodeProviderConfigs(providerId?: string, options: ZcodeProviderConfigOptions = {}): ZcodeProviderConfig[] {
  return readProviderConfigs(providerId, options, value => decryptZcodeProviderCredential(value, options.credentialSecret))
}

export async function readZcodeProviderConfigsAsync(providerId?: string, options: ZcodeProviderConfigOptions = {}): Promise<ZcodeProviderConfig[]> {
  const configs = readProviderConfigs(providerId, options, value => value)
  return Promise.all(configs.map(async config => {
    if (!config.source) return config
    const apiKey = await decryptZcodeCredential(config.source.apiKey, {
      credentialPath: resolveCredentialsPath(options),
      ...(options.credentialSecret ? { env: { ...process.env, ZCODE_CREDENTIAL_SECRET: options.credentialSecret } } : {}),
    })
    return { ...config, source: apiKey ? { ...config.source, apiKey } : null }
  }))
}

/** Match ZCode's default account-family selection; never pick an unrelated account. */
export async function readPreferredZcodeProviderConfig(options: ZcodeProviderConfigOptions = {}): Promise<ZcodeProviderConfig | undefined> {
  const configs = await readZcodeProviderConfigsAsync(undefined, options)
  const settings = readJson(join(options.homeDirectory ?? homedir(), '.zcode', 'v2', 'setting.json'))
  const selections = settings?.providerFamilyConnectionSelections
  if (!isRecord(selections)) return undefined
  for (const [family, selection] of Object.entries(selections)) {
    const kind = isRecord(selection) ? text(selection.kind) : null
    if (!kind) continue
    const selected = configs.find(c => c.providerId === `account:${family}-${kind}`)
    if (!selected) continue
    if (selected.source || ['start-plan', 'off-peak'].includes(selected.accessMode ?? '')) return selected
    const paid = configs.find(c => c.providerId.startsWith(`account:${family}-`) && c.source
      && ['individual-coding-plan', 'team-coding-plan'].includes(c.accessMode ?? ''))
    if (paid) return paid
    const credentials = readJson(resolveCredentialsPath(options))
    const start = configs.find(c => c.providerId === `account:${family}-start-plan`)
    return start && text(credentials?.zcodejwttoken) ? start : selected
  }
  return undefined
}

function readProviderConfigs(providerId: string | undefined, options: ZcodeProviderConfigOptions, decode: (value: string) => string): ZcodeProviderConfig[] {
  const home = options.homeDirectory ?? homedir()
  const runtime = options.runtime === undefined && options.homeDirectory === undefined
    ? resolveZCodeDesktopRuntime() : options.runtime
  const builtinPath = options.builtinProviderConfigPath
    ?? (options.homeDirectory === undefined ? process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE : undefined)
    ?? runtime?.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  const personalPath = options.personalProviderConfigPath
    ?? (options.homeDirectory === undefined ? process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE : undefined)
    ?? join(home, '.zcode', 'v2', 'provider_config.json')
  const documents = [readJson(builtinPath), readJson(personalPath)]
  const templates = new Map<string, Record<string, any>>()
  const providers = new Map<string, Record<string, any>>()
  for (const document of documents) {
    const rules = document?.config?.providerConfigRules
    for (const template of Array.isArray(rules?.templateRules) ? rules.templateRules : []) {
      if (typeof template?.templateId === 'string') templates.set(template.templateId, overlay(templates.get(template.templateId), template.config))
    }
  }
  for (const document of documents) {
    const rules = document?.config?.providerConfigRules?.providerRules
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (typeof rule?.providerId !== 'string') continue
      const base = providers.get(rule.providerId) ?? templates.get(rule.templateId)
      providers.set(rule.providerId, overlay(base, rule.config))
    }
  }
  const credentials = readJson(resolveCredentialsPath(options))
  return [...providers].filter(([id]) => providerId === undefined || id === providerId).map(([id, config]) => {
    const baseUrl = text(config.api?.baseUrl ?? config.api?.baseURL ?? config.baseUrl ?? config.baseURL ?? config.endpoint)
    // 账号套餐的凭据查找与模型目录共用同一套规则：coding-plan 槽位自己没有
    // api-key 时，复用同一账号族兄弟槽位的 key，这样「个人版套餐」这条也能读到
    // 自己的余额。start-plan / off-peak 仍走登录 JWT，不参与复用。
    const mode = text(config.access?.mode) ?? ''
    const planSlot = mode === 'individual-coding-plan' || mode === 'team-coding-plan'
    const entry = planSlot ? accountProviderApiKeyEntry(id, credentials ?? {}) : null
    const encoded = text(config.access?.apiKey ?? config.apiKey ?? config.api_key)
      ?? (entry === null ? null : text(credentials?.[entry.key]))
    const apiKey = encoded === null ? null : text(decode(encoded))
    return { providerId: id, ...(typeof config.access?.mode === 'string' ? { accessMode: config.access.mode } : {}),
      source: baseUrl === null || apiKey === null ? null : { baseUrl, apiKey } }
  })
}

/** AES-GCM 回退格式与本机 ZCode 一致；认证失败时不把密文当成 API Key。 */
export function decryptZcodeProviderCredential(value: string, credentialSecret?: string): string {
  if (!value.startsWith('enc:v1:')) return value.startsWith('enc:') ? '' : value.trim()
  const [ivRaw, tagRaw, cipherRaw] = value.slice(7).split('.')
  if (!ivRaw || !tagRaw || !cipherRaw) return ''
  try {
    let username = 'unknown'
    try { username = userInfo().username } catch { /* 受限环境可能没有用户名。 */ }
    const secret = credentialSecret ?? `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`
    const iv = Buffer.from(ivRaw, 'base64url')
    const tag = Buffer.from(tagRaw, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return ''
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(cipherRaw, 'base64url')), decipher.final()]).toString('utf8').trim()
  } catch { return '' }
}

function overlay(base: Record<string, any> | undefined, value: unknown): Record<string, any> {
  if (!isRecord(value)) return base ?? {}
  const result = { ...base, ...value }
  for (const key of ['api', 'access']) {
    if (isRecord(value[key])) result[key] = { ...base?.[key], ...value[key] }
  }
  return result
}

function resolveCredentialsPath(options: ZcodeProviderConfigOptions): string {
  return options.credentialsPath
    ?? (options.homeDirectory === undefined ? process.env.ZCODE_CREDENTIALS_FILE : undefined)
    ?? join(options.homeDirectory ?? homedir(), '.zcode', 'v2', 'credentials.json')
}

function readJson(path: string | undefined): Record<string, any> | null {
  if (path === undefined) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? value : null
  } catch { return null }
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }

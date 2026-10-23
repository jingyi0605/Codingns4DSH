import { resolveCodingNsTranslator, type CodingNsTranslator } from './locale.js'
import { fromCliProviderId } from '../shared/cli-provider-route.js'
import { PROVIDER_ICON_FILES } from '../shared/provider-icon-resources.js'

export interface ProviderVisual {
  readonly adapterId: string | null
  readonly displayName: string
  readonly iconUrl: string | undefined
  readonly color: string
}

interface ProviderDefinition {
  readonly adapterId: string
  readonly displayName: string
  readonly displayNameKey?: string
  readonly color: string
}

/** 未绑定和未知 Agent 使用中性灰，绝不冒充任一已知品牌色。 */
export const PROVIDER_NEUTRAL_COLOR = '#71717a'

/**
 * 外部 Agent 标识、显示名称与标签颜色的唯一映射。浏览器入口另行安装内联资产。
 *
 * 标签颜色用于会话行/归档列表的彩色标识：优先贴近本地图标或品牌色，
 * 并保持在浅色与深色主题下都可读的中等明度区间。
 */
const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> = {
  dsh: { adapterId: 'dsh', displayName: 'DeepSeek Harness', color: '#2563eb' },
  'command-code': { adapterId: 'command-code', displayName: 'Command Code', color: '#8b5cf6' },
  'claude-code': { adapterId: 'claude-code', displayName: 'Claude Code', color: '#d97757' },
  kimi: { adapterId: 'kimi', displayName: 'Kimi', color: '#0ea5e9' },
  gemini: { adapterId: 'gemini', displayName: 'Gemini CLI', color: '#4285f4' },
  pi: { adapterId: 'pi', displayName: 'Pi', color: '#f59e0b' },
  codex: { adapterId: 'codex', displayName: 'Codex', color: '#10a37f' },
  opencode: { adapterId: 'opencode', displayName: 'OpenCode', color: '#14b8a6' },
  grok: { adapterId: 'grok', displayName: 'Grok', color: '#71717a' },
  mcode: { adapterId: 'mcode', displayName: 'MiniMax Code', color: '#f97316' },
  zcode: { adapterId: 'zcode', displayName: 'ZCode', color: '#38bdf8' },
  codebuddy: { adapterId: 'codebuddy', displayName: 'CodeBuddy', color: '#2563eb' },
  workbuddy: { adapterId: 'workbuddy', displayName: 'WorkBuddy', color: '#0f766e' },
  'cursor-cli': { adapterId: 'cursor-cli', displayName: 'Cursor CLI', color: '#111827' },
  'kiro-cli': { adapterId: 'kiro-cli', displayName: 'Kiro CLI', color: '#7c3aed' },
  qoder: { adapterId: 'qoder', displayName: 'Qoder', color: '#ea580c' },
  'qoder-cn': { adapterId: 'qoder-cn', displayName: 'Qoder CN', color: '#c2410c' },
  antigravity: { adapterId: 'antigravity', displayName: 'Antigravity', color: '#1d4ed8' },
  doubao: { adapterId: 'doubao', displayName: 'Doubao App', displayNameKey: 'provider.doubao', color: '#477fe8' },
}

const PROVIDER_ICONS: Record<string, string> = {}

const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  commandcode: 'command-code',
  'minimax-code': 'mcode',
  minimax: 'mcode',
  cursor: 'cursor-cli',
  agy: 'antigravity',
  codingns4dsh: 'dsh',
  'workbuddy-ai': 'workbuddy',
  'grok-(supergrok)': 'grok',
  openai: 'codex',
  'openai-api': 'codex',
  'openai-subscription': 'codex',
  'codex-subscription': 'codex',
  anthropic: 'claude-code',
  'anthropic-subscription': 'claude-code',
  'claude-subscription': 'claude-code',
  'gemini-cli': 'gemini',
  'google-gemini': 'gemini',
  'codebuddy-cn': 'codebuddy',
  deepseek: 'dsh',
  'deepseek-api': 'dsh',
  'deepseek-harness': 'dsh',
  'deepseek-subscription': 'dsh',
  supergrok: 'grok',
}

const MODEL_PROVIDER_PATTERNS: readonly [RegExp, string][] = [
  [/(?:^|[\-/])deepseek(?:[-./]|$)/u, 'dsh'],
  [/(?:^|[\-/])codex(?:[-./]|$)/u, 'codex'],
  [/(?:^|[\-/])gpt(?:[-./]|$)/u, 'codex'],
  [/(?:^|[\-/])(?:claude|opus|sonnet|haiku)(?:[-./]|$)/u, 'claude-code'],
  [/(?:^|[\-/])gemini(?:[-./]|$)/u, 'gemini'],
  [/(?:^|[\-/])kimi(?:[-./]|$)/u, 'kimi'],
  [/(?:^|[\-/])grok(?:[-./]|$)/u, 'grok'],
  [/(?:^|[\-/])(?:minimax|mcode)(?:[-./]|$)/u, 'mcode'],
  [/(?:^|[\-/])workbuddy(?:[-./]|$)/u, 'workbuddy'],
  [/(?:^|[\-/])codebuddy(?:[-./]|$)/u, 'codebuddy'],
  [/(?:^|[\-/])cursor(?:[-./]|$)/u, 'cursor-cli'],
  [/(?:^|[\-/])qoder(?:[-./]|$)/u, 'qoder'],
  [/(?:^|[\-/])command(?:-?code)(?:[-./]|$)/u, 'command-code'],
  [/(?:^|[\-/])zcode(?:[-./]|$)/u, 'zcode'],
  [/(?:^|[\-/])antigravity(?:[-./]|$)/u, 'antigravity'],
]

const KNOWN_PROVIDER_ICON_IDS = new Set([
  ...Object.keys(PROVIDER_DEFINITIONS),
  ...Object.keys(PROVIDER_ICON_FILES),
  ...Object.values(PROVIDER_ICON_ALIASES),
])

/** 只由浏览器入口调用，使普通 Node 测试不需要加载 png/svg。 */
export function installProviderIcons(icons: Readonly<Record<string, string>>): void {
  for (const adapterId of Object.keys(PROVIDER_ICONS)) delete PROVIDER_ICONS[adapterId]
  // 资源也包含 R4 等上游品牌，不要求它同时是可执行的 Agent。
  for (const adapterId of Object.keys(icons)) {
    const iconUrl = icons[adapterId]
    if (iconUrl !== undefined) PROVIDER_ICONS[adapterId] = iconUrl
  }
}

export function providerIconUrl(adapterId: string): string | undefined {
  return providerIconUrlForIdentities([adapterId])
}

/**
 * Resolve one canonical provider asset ID from the identities emitted by a
 * Magpie record. Specific provider identities win over the Magpie gateway;
 * model-family inference is only used when no provider identity is known.
 */
export function resolveProviderIconId(identities: readonly (string | null | undefined)[]): string | undefined {
  const candidates = providerIconCandidates(identities)
  return candidates[0]
}

/** Resolve and load a logo for a record that may expose several identities. */
export function providerIconUrlForIdentities(identities: readonly (string | null | undefined)[]): string | undefined {
  for (const iconId of providerIconCandidates(identities)) {
    const iconUrl = PROVIDER_ICONS[iconId]
    if (iconUrl !== undefined) return iconUrl
  }
  return undefined
}

/**
 * 未绑定和未知值都返回中性占位，绝不冒充任一已知品牌。
 *
 * 第二个参数是 Codingns4DSH 词典翻译函数；未提供时退回内置中文词典，
 * 保证不接 locale 的调用方与单测仍能拿到稳定的展示名。
 */
export function providerVisual(adapterId: string | undefined, t?: CodingNsTranslator): ProviderVisual {
  const translate = t ?? resolveCodingNsTranslator()
  if (adapterId === undefined || adapterId.trim() === '') {
    return { adapterId: null, displayName: translate('provider.unbound'), iconUrl: undefined, color: PROVIDER_NEUTRAL_COLOR }
  }
  const normalizedAdapterId = normalizeProviderAdapterId(adapterId)
  const definition = PROVIDER_DEFINITIONS[normalizedAdapterId]
  if (definition === undefined) {
    return { adapterId, displayName: translate('provider.unknown', { adapterId }), iconUrl: undefined, color: PROVIDER_NEUTRAL_COLOR }
  }
  return { ...definition, displayName: definition.displayNameKey ? translate(definition.displayNameKey) : definition.displayName, iconUrl: providerIconUrl(adapterId) }
}

/** 兼容旧版 CN profile 的会话快照，但不重新暴露第二个 Provider。 */
function normalizeProviderAdapterId(adapterId: string): string {
  const normalized = fromCliProviderId(adapterId) ?? adapterId
  return normalized === 'codebuddy-cn' ? 'codebuddy' : normalized
}

function providerIconCandidates(identities: readonly (string | null | undefined)[]): readonly string[] {
  const specific: string[] = []
  const inferred: string[] = []
  const gateway: string[] = []
  const seen = new Set<string>()
  let hasSpecificProvider = false

  const add = (target: string[], iconId: string): void => {
    if (seen.has(iconId)) return
    seen.add(iconId)
    target.push(iconId)
  }

  for (const identity of identities) {
    if (identity === undefined || identity === null || identity.trim() === '') continue
    const normalized = normalizeProviderIdentity(identity)
    const cliAdapterId = fromCliProviderId(normalized)
    const values = [
      ...(cliAdapterId === undefined ? [] : [normalizeProviderIdentity(cliAdapterId)]),
      normalized,
      ...normalized.split('/').filter((value) => value !== '').reverse(),
    ]
    for (const value of values) {
      const iconId = canonicalProviderIconId(value)
      if (iconId === undefined) continue
      if (iconId === 'magpie') add(gateway, iconId)
      else {
        hasSpecificProvider = true
        add(specific, iconId)
      }
    }
    for (const value of values) {
      for (const [pattern, iconId] of MODEL_PROVIDER_PATTERNS) {
        if (pattern.test(value)) add(inferred, iconId)
      }
    }
  }

  // Do not let a gateway label mask the actual provider or a recognizable model family.
  return hasSpecificProvider ? specific : [...inferred, ...gateway]
}

function canonicalProviderIconId(value: string): string | undefined {
  const normalized = normalizeProviderIdentity(value)
  const aliased = PROVIDER_ICON_ALIASES[normalized] ?? normalized
  if (KNOWN_PROVIDER_ICON_IDS.has(aliased) || PROVIDER_ICONS[aliased] !== undefined) return aliased
  return undefined
}

function normalizeProviderIdentity(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_]+/gu, '-')
}

export { PROVIDER_DEFINITIONS, PROVIDER_ICONS }

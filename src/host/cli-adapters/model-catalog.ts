import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'

/**
 * 外部 CLI 没有稳定的模型目录接口时，使用随适配器验证过的最小目录。
 * 目录只保存模型 id 和 CLI 接受的思考档位，不包含凭据或远端响应。
 */
export function staticCatalog(
  groupId: string,
  groupName: string,
  models: readonly { id: string; name?: string; efforts: readonly string[] }[],
): CodingNsCliModelCatalog {
  return {
    groups: [{
      id: groupId,
      name: groupName,
      models: models.map((model) => ({ id: model.id, name: model.name ?? model.id, efforts: model.efforts })),
    }],
    currentModel: null,
    currentEffort: null,
  }
}

const GEMINI_EFFORTS_BY_MODEL = new Map<string, readonly string[]>([
  ['provider-default', ['low', 'medium', 'high']],
  ['auto', ['low', 'medium', 'high']],
  ['auto-gemini-3', ['low', 'medium', 'high']],
  ['auto-gemini-2.5', ['low', 'medium', 'high']],
  ['gemini-3.8-flash', ['low', 'medium', 'high']],
  ['gemini-3.7-flash', ['low', 'medium', 'high']],
  ['gemini-3.6-flash', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash-lite', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.1-pro-preview', ['low', 'medium', 'high']],
  ['gemini-3.1-pro-preview-customtools', ['low', 'medium', 'high']],
  ['gemini-3.1-flash-lite-image', ['minimal', 'high']],
  ['gemini-3-flash-preview', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3-pro-preview', ['low', 'high']],
  ['gemini-2.5-pro', ['low', 'medium', 'high']],
  ['gemini-2.5-flash', ['low', 'medium', 'high']],
  ['gemini-2.5-flash-lite', ['low', 'medium', 'high']],
])

/** Gemini ACP 只返回模型标识；思考档位需按 Gemini 官方能力表补齐。 */
export function resolveGeminiEfforts(modelId: string): readonly string[] {
  return GEMINI_EFFORTS_BY_MODEL.get(modelId.trim().toLowerCase()) ?? []
}

/**
 * Claude Code `--effort` 接受的档位，同时也是静态目录和 CLI 探测失败时的兜底。
 *
 * 该档位表属于 CLI 会话级参数，与具体模型无关：即使经 `ANTHROPIC_BASE_URL`
 * 接入中转站，`claude` 仍会把选中的档位写进请求的 `output_config.effort`。
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const CLAUDE_CATALOG = staticCatalog('claude', 'Claude', [
  { id: 'provider-default', name: '跟随 Claude 默认模型', efforts: CLAUDE_EFFORT_LEVELS },
  { id: 'sonnet', efforts: CLAUDE_EFFORT_LEVELS },
  { id: 'opus', efforts: CLAUDE_EFFORT_LEVELS },
  { id: 'haiku', efforts: CLAUDE_EFFORT_LEVELS },
])

export const KIMI_CATALOG = staticCatalog('kimi', 'Kimi', [
  { id: 'provider-default', name: '跟随 Kimi 默认模型', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k2.5', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k2-thinking', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k3', efforts: ['low', 'high', 'max'] },
])

export const GEMINI_CATALOG = staticCatalog('gemini', 'Gemini', [
  { id: 'provider-default', name: '跟随 Gemini 默认模型', efforts: resolveGeminiEfforts('provider-default') },
  { id: 'auto-gemini-3', efforts: resolveGeminiEfforts('auto-gemini-3') },
  { id: 'auto-gemini-2.5', efforts: resolveGeminiEfforts('auto-gemini-2.5') },
  { id: 'gemini-3.1-pro-preview', efforts: resolveGeminiEfforts('gemini-3.1-pro-preview') },
  { id: 'gemini-3-flash-preview', efforts: resolveGeminiEfforts('gemini-3-flash-preview') },
  { id: 'gemini-2.5-pro', efforts: resolveGeminiEfforts('gemini-2.5-pro') },
  { id: 'gemini-2.5-flash', efforts: resolveGeminiEfforts('gemini-2.5-flash') },
  { id: 'gemini-2.5-flash-lite', efforts: resolveGeminiEfforts('gemini-2.5-flash-lite') },
])

export const CODEX_CATALOG = staticCatalog('codex', 'Codex', [
  { id: 'provider-default', name: '跟随 Codex 默认模型', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
])

/**
 * Codex app-server 不提供模型容量的目录接口（model/list 不含 contextWindow，
 * config/read 的 model_context_window 默认也是 null），首个 tokenUsage 到达前
 * DSH 的分母只能靠已知模型提示。这里只列本机 rollout `token_count` 事件
 * （payload.info.model_context_window）验证过的模型；该值会随服务端变化
 * （gpt-5.6-sol 曾从 353400 调整为 258400），因此提示只用于首个 Provider
 * usage 到达前的占位，与已确认 usage 冲突时不会被写入。
 */
const CODEX_CONTEXT_WINDOWS = new Map<string, number>([
  ['codex-auto-review', 258400],
  ['gpt-5.4', 258400],
  ['gpt-5.5', 258400],
  ['gpt-5.6-luna', 258400],
  ['gpt-5.6-sol', 258400],
  ['gpt-5.6-terra', 258400],
  ['gpt-6-astra', 258400],
  ['gpt-6-luna', 258400],
  ['gpt-6-sol', 258400],
  ['gpt-6.1-sol', 258400],
])

export function knownCodexContextWindow(modelId: string | undefined): number | undefined {
  if (modelId === undefined) return undefined
  return CODEX_CONTEXT_WINDOWS.get(modelId.trim().toLowerCase())
}

/**
 * Command Code 已知模型的上下文窗口。
 *
 * Command Code 的状态命令只返回当前配置模型，不能覆盖通过 `-m` 选择的会话模型。
 * 这里复用父仓库随 CLI 目录验证过的窗口；未知模型返回 undefined，避免把错误分母
 * 写进 DSH 原生会话。
 */
const COMMAND_CODE_CONTEXT_WINDOWS = new Map<string, number>([
  ['claude-fable-5', 1_000_000],
  ['claude-fable-5-1', 1_000_000],
  ['claude-haiku-4-5-20251001', 200_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['deepseek/deepseek-v4-flash', 1_000_000],
  ['deepseek/deepseek-v4-flash-fast', 1_000_000],
  ['deepseek/deepseek-v4-flash-vision-exp', 1_000_000],
  ['deepseek/deepseek-v4-pro', 1_000_000],
  ['deepseek/deepseek-v4.1-flash', 1_000_000],
  ['google/gemini-3.1-flash-lite', 1_000_000],
  ['google/gemini-3.5-flash', 1_000_000],
  ['google/gemini-3.5-flash-lite', 1_000_000],
  ['google/gemini-3.6-flash', 1_000_000],
  ['google/gemini-3.7-flash', 1_048_576],
  ['google/gemini-3.8-flash', 1_000_000],
  ['gpt-5.3-codex', 400_000],
  ['gpt-5.4', 400_000],
  ['gpt-5.4-mini', 400_000],
  ['gpt-5.5', 400_000],
  ['gpt-5.6-luna', 1_050_000],
  ['gpt-5.6-sol', 1_050_000],
  ['gpt-5.6-terra', 1_050_000],
  ['gpt-6-astra', 1_050_000],
  ['inclusionai/ling-3.0-flash-free', 256_000],
  ['inclusionai/ling-3.0-flash-sante:free', 262_144],
  ['meituan/longcat-2.0:free', 1_048_576],
  ['meta/muse-spark-1.1', 1_048_576],
  ['meta/muse-spark-1.2', 1_048_576],
  ['meta/muse-spark-1.2-contributor', 1_048_576],
  ['meta/muse-spark-1.3', 1_048_576],
  ['meta/muse-spark-1.3-contributor', 1_048_576],
  ['minimax/minimax-m2.7-free', 197_000],
  ['minimax/minimax-m3-free', 1_000_000],
  ['minimaxai/minimax-m2.5', 200_000],
  ['minimaxai/minimax-m3', 1_000_000],
  ['minimaxai/minimax-m3-free', 1_000_000],
  ['moonshotai/kimi-k2.5', 256_000],
  ['moonshotai/kimi-k2.6', 256_000],
  ['moonshotai/kimi-k2.7-code', 256_000],
  ['moonshotai/kimi-k2.7-code-highspeed', 262_000],
  ['moonshotai/kimi-k3', 1_000_000],
  ['nvidia/nemotron-3-ultra-550b-a55b', 1_000_000],
  ['poolside/laguna-s-2.1-free', 256_000],
  ['qwen/qwen3.7-flash', 1_000_000],
  ['qwen/qwen3.7-max', 1_000_000],
  ['qwen/qwen3.7-plus', 1_000_000],
  ['qwen/qwen3.8-27b', 262_144],
  ['qwen/qwen3.8-flash', 1_000_000],
  ['qwen/qwen3.8-max', 1_000_000],
  ['qwen/qwen3.8-max-0902', 1_000_000],
  ['sakana/fugu-ultra', 1_000_000],
  ['stepfun/step-3.5-flash', 1_000_000],
  ['stepfun/step-3.7-flash', 256_000],
  ['tencent/hy3', 262_144],
  ['tencent/hy3-paid', 262_144],
  ['tencent/hy4-preview', 1_048_576],
  ['thinkingmachines/inkling', 256_000],
  ['thinkingmachines/inkling-small', 1_000_000],
  ['xai/grok-4.5', 500_000],
  ['xai/grok-4.6', 500_000],
  ['xiaomi/mimo-v2.5', 1_000_000],
  ['xiaomi/mimo-v2.5-pro', 1_000_000],
  ['z-ai/glm-5.3-flash', 1_048_576],
  ['zai-org/glm-5', 200_000],
  ['zai-org/glm-5.2', 1_000_000],
  ['zai-org/glm-5.2-fast', 1_000_000],
  ['zai-org/glm-5.3', 1_000_000],
])

export function knownCommandCodeContextWindow(modelId: string | undefined): number | undefined {
  if (modelId === undefined) return undefined
  return COMMAND_CODE_CONTEXT_WINDOWS.get(modelId.trim().toLowerCase())
}

export const GROK_CATALOG = staticCatalog('grok', 'Grok', [
  { id: 'provider-default', name: '跟随 Grok 默认模型', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'grok-4.6', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'grok-4.5', efforts: ['low', 'medium', 'high'] },
])

export const PI_CATALOG = staticCatalog('pi', 'Pi', [
  { id: 'provider-default', name: '跟随 Pi 默认模型', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
])

/** MiniMax Code 的稳定默认目录；运行时会优先读取 CLI 自己的 config.yaml。 */
export const MINIMAX_CODE_CATALOG = staticCatalog('mcode', 'MiniMax Code', [
  { id: 'provider-default', name: '跟随 MiniMax Code 默认模型', efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'minimax/MiniMax-M2.7', name: 'MiniMax-M2.7', efforts: ['low', 'medium', 'high'] },
])

/** ZCode 动态目录尚未建立时的保守回退项；正常桌面运行时会用会话快照替换。 */
export const ZCODE_CATALOG = staticCatalog('zcode', 'ZCode', [
  { id: 'provider-default', name: '跟随 ZCode 默认模型', efforts: [] },
])

/** 豆包 App 的产品档位；不是实时模型列表，不推断底层模型、额度或上下文容量。 */
export const DOUBAO_CATALOG: CodingNsCliModelCatalog = {
  ...staticCatalog('doubao', '豆包 App 产品档位', [
    { id: 'doubao-fast', name: '快速', efforts: [] },
    { id: 'doubao-expert', name: '专家', efforts: [] },
    { id: 'doubao-work', name: '工作任务（云端）', efforts: [] },
  ]),
  currentModel: 'doubao-fast',
  fallback: true,
}

/** Antigravity 在模型命令不可用时使用的保守回退目录。 */
export const ANTIGRAVITY_CATALOG: CodingNsCliModelCatalog = {
  ...staticCatalog('antigravity', 'Antigravity', [
    { id: 'provider-default', name: '跟随 Antigravity 默认模型', efforts: [] },
  ]),
  fallback: true,
}

const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const
const ANTIGRAVITY_EFFORT_SUFFIX = /^(?<base>.+)-(?<effort>low|medium|high)$/u
const ANTIGRAVITY_EFFORT_LABEL = /\s*\((?:low|medium|high)\)$/iu

/** 解析 `agy models` 的制表符目录，并把带档位后缀的条目合并到同一模型。 */
export function parseAntigravityModels(output: string): CodingNsCliModelCatalog {
  const grouped = new Map<string, { name: string; efforts: string[] }>()
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || /^fetching available models\.\.\.$/iu.test(line)) continue
    const match = line.match(/^([^\s]+)[\t ]+(.+)$/u)
    if (!match) continue
    const id = match[1]!.trim()
    const label = match[2]!.trim()
    const suffix = id.match(ANTIGRAVITY_EFFORT_SUFFIX)
    const baseId = suffix?.groups?.base?.trim() || id
    const effort = suffix?.groups?.effort
    const entry = grouped.get(baseId) ?? {
      name: label.replace(ANTIGRAVITY_EFFORT_LABEL, '').trim() || label,
      efforts: [],
    }
    if (effort !== undefined && !entry.efforts.includes(effort)) entry.efforts.push(effort)
    grouped.set(baseId, entry)
  }
  if (grouped.size === 0) return ANTIGRAVITY_CATALOG
  const models = [
    { id: 'provider-default', name: '跟随 Antigravity 默认模型', efforts: [] as readonly string[] },
    ...[...grouped.entries()].map(([id, entry]) => ({
      id,
      name: entry.name || id,
      efforts: ANTIGRAVITY_EFFORTS.filter((effort) => entry.efforts.includes(effort)),
    })),
  ]
  return staticCatalog('antigravity', 'Antigravity', models)
}

/**
 * Antigravity 各模型的上下文窗口。
 *
 * `agy` 的 stream-json 事件只携带 `input_tokens` / `output_tokens` /
 * `thinking_tokens` / `cache_read_tokens` / `total_tokens` 五项用量，任何事件都
 * 不报告上下文容量。唯一第一手来源是 CLI 自己拉取模型目录时调用的
 * `v1internal:fetchAvailableModels`，其 `models[*].maxTokens` 即窗口；本机实测
 * （agy 1.2.17，2026-10-05）：Gemini 系 1048576、Claude 系 250000、
 * GPT-OSS 120B 131072。该值随服务端变化，只作为 token-meter 的分母提示。
 */
const ANTIGRAVITY_CONTEXT_WINDOWS = new Map<string, number>([
  // `agy models` 暴露的模型 id（档位后缀已由 parseAntigravityModels 剥离）
  ['gemini-3.8-flash', 1_048_576],
  ['gemini-3.7-flash', 1_048_576],
  ['gemini-3.6-flash', 1_048_576],
  ['gemini-3.5-flash', 1_048_576],
  ['gemini-3.5-flash-lite', 1_048_576],
  ['gemini-3.1-pro', 1_048_576],
  ['gemini-3.1-flash-lite', 1_048_576],
  ['gemini-3-flash', 1_048_576],
  ['gemini-2.5-pro', 1_048_576],
  ['gemini-2.5-flash', 1_048_576],
  ['claude-sonnet-4-6', 250_000],
  ['claude-opus-4-6-thinking', 250_000],
  ['gpt-oss-120b', 131_072],
  // AGY 设置文件里展示名去掉档位括号后的写法（Claude 的版本号用点号）
  ['claude-sonnet-4.6', 250_000],
  ['claude-opus-4.6', 250_000],
])

/**
 * `provider-default` 时 AGY 用的是它自己设置里选中的模型，而不是 DSH 侧的空 id。
 * 目录接口的 `defaultAgentModelId` 是 `gemini-3.6-flash-high`（1048576），因此
 * 读不到设置文件时按这个默认模型取窗口。
 */
const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 1_048_576

export interface AntigravityContextWindowOptions {
  readonly homeDirectory?: string
  readonly readFile?: (path: string) => string
}

/**
 * 解析 Antigravity 会话的上下文窗口。
 *
 * 显式模型 id 直接查表；`provider-default` 时读取 AGY 自己的设置文件
 * （`~/.gemini/antigravity-cli/settings.json` 的 `model` 展示名），把展示名还原成
 * CLI 模型 id 后查表，避免把 Gemini 的 1M 分母套到 Claude 的 250K 会话上。
 * 未知模型返回 undefined：宁可没有分母，也不写入错误容量。
 */
export function knownAntigravityContextWindow(
  modelId: string | undefined,
  options: AntigravityContextWindowOptions = {},
): number | undefined {
  const resolved = resolveAntigravityModelId(modelId, options)
  if (resolved !== null) {
    const window = ANTIGRAVITY_CONTEXT_WINDOWS.get(resolved)
    if (window !== undefined) return window
    // 显式指定的未知模型没有可信窗口；只有 provider-default 才退回默认模型。
    if (!isProviderDefaultModel(modelId)) return undefined
  }
  return ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW
}

/**
 * 解析 Antigravity 会话实际使用的模型。
 *
 * 显式模型 id 直接返回；`provider-default` 时读取 AGY 自己的设置文件
 * （`~/.gemini/antigravity-cli/settings.json` 的 `model` 展示名）并还原成模型键。
 * 读不到时返回 null，调用方按 AGY 默认 Agent 模型（Gemini 系）处理。
 */
export function resolveAntigravityModelId(
  modelId: string | undefined,
  options: AntigravityContextWindowOptions = {},
): string | null {
  const normalized = modelId?.trim().toLowerCase()
  if (normalized !== undefined && normalized !== '' && normalized !== 'provider-default') return normalized
  return readAntigravitySelectedModel(options)
}

/**
 * Antigravity 的缓存字段语义随模型 Provider 不同，实测（agy 1.2.17）：
 *
 * - Claude 模型沿用 Anthropic 口径：`input_tokens` 只含未缓存输入，缓存命中单独放在
 *   `cache_read_tokens`（首轮 3968 + 9619，第二轮 682 + 13120）。
 * - Gemini / GPT-OSS 模型：`input_tokens` 是完整提示规模，`cache_read_tokens` 在本机
 *   全部 16 条历史样本里恒为 0。
 *
 * 两者都满足 `total_tokens = input_tokens + output_tokens`，无法用总量区分；只有
 * Claude 口径需要把缓存读取从输入里排除，因此按模型前缀判定。
 */
export function antigravityUsageExcludesCacheFromInput(modelId: string | null): boolean {
  return modelId !== null && modelId.startsWith('claude')
}

/**
 * AGY 是否接受该模型的 `--effort`。
 *
 * 实测（agy 1.2.17，逐个模型下发并读取 CLI 的校验报错）：
 *
 * - Gemini：`low` / `medium` / `high`（`--effort xhigh` 报 “available: low, medium, high”）
 * - GPT-OSS 120B：只有 `medium`（`--effort low` 报 “available: medium”）
 * - Claude 系列：完全不支持（`--effort is not supported for model "claude-sonnet-4-6"`），
 *   换 `-thinking` 等 id 写法同样是这个错误
 *
 * Claude 的档位列表必须在目录里保持为空，并且旧会话残留的档位不能被下发：
 * AGY 会把它当成 `invalid model selection` 直接拒绝整轮。
 */
export function antigravitySupportsEffort(modelId: string | null): boolean {
  return modelId === null || !modelId.trim().toLowerCase().startsWith('claude')
}

/** 把 AGY 设置里的模型展示名还原成查表用的模型键。 */
export function antigravityModelIdFromLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase()
    // 展示名尾部的 "(High)"/"(Thinking)" 是档位或说明标注，不属于模型键。
    .replace(/\s*\([^)]*\)\s*$/u, '')
    .replace(/\s+/gu, '-')
  if (normalized === '') return null
  return normalized.replace(ANTIGRAVITY_EFFORT_SUFFIX, '$<base>')
}

function readAntigravitySelectedModel(options: AntigravityContextWindowOptions): string | null {
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const home = options.homeDirectory ?? homedir()
  try {
    const parsed: unknown = JSON.parse(read(join(home, '.gemini', 'antigravity-cli', 'settings.json')))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const label = (parsed as Record<string, unknown>).model
    return typeof label === 'string' ? antigravityModelIdFromLabel(label) : null
  } catch {
    // 设置文件缺失或损坏时退回 AGY 的默认 Agent 模型窗口。
    return null
  }
}

/** 把 CLI 帮助解析到的模型补上已知档位，未知模型保持空数组。 */
export function enrichEfforts(catalog: CodingNsCliModelCatalog, known: CodingNsCliModelCatalog): CodingNsCliModelCatalog {
  const effortById = new Map(known.groups.flatMap((group) => group.models.map((model) => [model.id.toLowerCase(), model.efforts] as const)))
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      models: group.models.map((model) => ({ ...model, efforts: effortById.get(model.id.toLowerCase()) ?? model.efforts })),
    })),
  }
}

/**
 * 用同一个 Provider 已知的档位补齐目录中仍为空的模型。
 *
 * Claude Code 的 `--effort` 是会话级参数，档位不随模型变化：中转站自定义命名的
 * 模型在官方目录里匹配不到 ID，但 CLI 依然接受同一组档位。此时沿用同 Provider
 * 已确认的档位，而不是把强度切换静默置空。
 *
 * `excludedIds` 是 CLI 明确回报不支持思考档位的模型；这些模型必须保持空数组，
 * 不能被 Provider 级档位覆盖，否则 UI 会提供实际无效的选项。匹配与
 * `enrichEfforts` 一样忽略大小写，避免同名的中转模型出现互相矛盾的档位。
 */
export function fillProviderEfforts(
  catalog: CodingNsCliModelCatalog,
  levels: readonly string[],
  excludedIds: ReadonlySet<string> = new Set(),
): CodingNsCliModelCatalog {
  if (levels.length === 0 && excludedIds.size === 0) return catalog
  const excluded = new Set([...excludedIds].map((id) => id.toLowerCase()))
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      models: group.models.map((model) => {
        if (excluded.has(model.id.toLowerCase())) return model.efforts.length === 0 ? model : { ...model, efforts: [] }
        return model.efforts.length > 0 ? model : { ...model, efforts: levels }
      }),
    })),
  }
}

/**
 * 清空目录中所有模型的思考档位。
 *
 * 用于 CLI 明确不支持该能力时：与其让 UI 展示一个切换后不生效的选项，
 * 不如不展示——「可选但无效」正是本适配器此前被报告的缺陷形态。
 */
export function clearEfforts(catalog: CodingNsCliModelCatalog): CodingNsCliModelCatalog {
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      models: group.models.map((model) => (model.efforts.length === 0 ? model : { ...model, efforts: [] })),
    })),
  }
}

export function isProviderDefaultModel(modelId: string | undefined): boolean {
  return modelId === undefined || modelId === '' || modelId === 'provider-default'
}

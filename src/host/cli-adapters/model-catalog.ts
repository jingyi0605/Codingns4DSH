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

export const CLAUDE_CATALOG = staticCatalog('claude', 'Claude', [
  { id: 'provider-default', name: '跟随 Claude 默认模型', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
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

export function isProviderDefaultModel(modelId: string | undefined): boolean {
  return modelId === undefined || modelId === '' || modelId === 'provider-default'
}

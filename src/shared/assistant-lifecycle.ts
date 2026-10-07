import type { AssistantProfileSettings, AssistantSettings } from './contracts/config.js'
import { parseVirtualWorkspaceId } from './contracts/peer-host.js'

export const DEFAULT_ASSISTANT_NAME = '我的助理'
/** 首次创建预填的标准性格；作为草稿数据，用户可修改或清空。 */
export const DEFAULT_ASSISTANT_PERSONALITY = '你是一位友善、耐心、可靠的智能助理，是用户工作与生活中的伙伴。善于倾听，表达自然简洁，优先给出清晰结论和可执行建议，再按需解释细节。遇到不确定的信息会如实说明并主动澄清，尊重用户的选择与隐私，不编造事实或经历。'
export const ASSISTANT_PERSONALITY_MAX_CHARS = 4000

/** 只为未创建且尚无设定的助理补默认值；显式空白和已有档案保持原样。 */
export function readAssistantPersonality(profile: AssistantProfileSettings): string {
  return profile.personality ?? (profile.initialized ? '' : DEFAULT_ASSISTANT_PERSONALITY)
}

/** 角色设定可以留空，但不能绕过正式配置与预览共同的长度限制。 */
export function validateAssistantPersonality(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > ASSISTANT_PERSONALITY_MAX_CHARS) throw new TypeError('助理性格背景必须是最多 4000 字符的文字')
}

/** 原生侧栏可能投影虚拟 ID；范围比较保留用户选择，同时核对其所属 Host。 */
export function assistantWorkspaceMatches(selected: string, hostId: string, workspaceId: string, local = false): boolean {
  if (selected === workspaceId || selected === `${hostId}:${workspaceId}`) return true
  const virtual = parseVirtualWorkspaceId(selected)
  return virtual !== null && virtual.workspaceId === workspaceId && (virtual.hostId === hostId || local && virtual.targetHostId === null)
}

/** 只有显式档案表示已创建；旧能力配置仅预填表单，不能跳过首次创建。 */
export function readAssistantProfile(settings: AssistantSettings): AssistantProfileSettings {
  if (settings.profile !== undefined) return { ...settings.profile }
  return { name: DEFAULT_ASSISTANT_NAME, initialized: false, createdAt: null }
}

/** 设置和生命周期接口共用严格校验，写入失败不能被默认值掩盖。 */
export function validateAssistantProfile(value: unknown): asserts value is AssistantProfileSettings {
  const profile = value as Partial<AssistantProfileSettings> | null
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)
    || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80
    || profile.personality !== undefined && (typeof profile.personality !== 'string' || profile.personality.length > ASSISTANT_PERSONALITY_MAX_CHARS)
    || typeof profile.initialized !== 'boolean'
    || profile.createdAt !== null && (!Number.isSafeInteger(profile.createdAt) || profile.createdAt! < 0)) throw new TypeError('助理档案无效')
}

export function validateAssistantModel(value: unknown): asserts value is NonNullable<AssistantSettings['model']> {
  const model = value as AssistantSettings['model'] | null
  if (model === null || typeof model !== 'object' || Array.isArray(model)
    || typeof model.provider !== 'string' || !model.provider.trim() || model.provider.length > 200
    || typeof model.model !== 'string' || !model.model.trim() || model.model.length > 200) throw new TypeError('助理模型无效')
}

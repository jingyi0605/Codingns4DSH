import type { AssistantChatCatalog } from '../../shared/contracts/assistant.js'
import type { AssistantSettings } from '../../shared/contracts/config.js'
import { readAssistantProfile, readAssistantPersonality, validateAssistantModel, validateAssistantPersonality } from '../../shared/assistant-lifecycle.js'
import { listAssistantAvatars, normalizeAssistantAppearance } from '../../shared/assistant-avatar.js'
import { MOSS_BUILTIN_VOICES, readAssistantTtsSettings } from '../../shared/assistant-tts.js'
import { CodingNsSettingsSchema } from '../settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../../shared/contracts/config.js'

/** 在写入前完成所有配置校验；输入只选择已登记资源，不接受浏览器本地路径。 */
export function configureAssistantSettings(current: AssistantSettings, payload: unknown, catalog: AssistantChatCatalog, workspaceIds: readonly string[]): AssistantSettings {
  const value = payload as Record<string, unknown> | null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('助理配置无效')
  current = mergeConfiguration(current, value.configurationPatch)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('助理名称需要 1 到 80 个字符')
  const profile = readAssistantProfile(current)
  const personality = value.personality === undefined ? readAssistantPersonality(profile) : value.personality
  validateAssistantPersonality(personality)
  // 首次表单只有角色设定，项目和声音缺省时保留资源与范围，输出默认使用浏览器。
  const scope = value.managedWorkspaceIds === undefined ? current.managedWorkspaceIds : value.managedWorkspaceIds
  if (!Array.isArray(scope) || scope.length > 1000 || scope.some((id) => typeof id !== 'string' || !id || id.length > 512)) throw new Error('工作区范围无效')
  const selected = value.model
  if (selected !== undefined && selected !== null) validateAssistantModel(selected)
  const model = selected as AssistantSettings['model'] | null
  if (model != null && !catalog.models.some((item) => item.provider === model.provider && item.model === model.model)) throw new Error('所选助理模型不可用')
  if (model == null && catalog.default === null) throw new Error('DSH 默认模型不可用，请选择助理模型')
  const known = new Set([...workspaceIds, ...current.managedWorkspaceIds])
  const managedWorkspaceIds = [...new Set(scope as string[])]
  if (managedWorkspaceIds.some((id) => !known.has(id))) throw new Error('所选工作区不可用，请刷新项目列表')
  const appearance = normalizeAssistantAppearance(current.appearance)
  if (typeof value.avatarId !== 'string' || !listAssistantAvatars(appearance, profile.initialized).some((item) => item.id === value.avatarId)) throw new Error('所选形象尚未登记')
  const tts = readAssistantTtsSettings(current.tts)
  if (value.ttsBackend !== undefined && value.ttsBackend !== 'browser' && value.ttsBackend !== 'moss-onnx') throw new Error('语音输出后端无效')
  const voiceId = value.voiceId === undefined ? tts.selectedId : value.voiceId
  if (typeof voiceId !== 'string' || ![...MOSS_BUILTIN_VOICES, ...tts.voices].some((voice) => voice.id === voiceId)) throw new Error('所选音色不存在')
  const backend = value.ttsBackend as typeof tts.backend | undefined ?? (profile.initialized ? tts.backend : 'browser')
  const { model: _oldModel, ...rest } = current
  return { ...rest, profile: { name: value.name.trim(), personality: personality.trim(), initialized: true, createdAt: profile.createdAt ?? Date.now() },
    ...(model == null ? {} : { model: { provider: model.provider, model: model.model } }), managedWorkspaceIds,
    appearance: { ...appearance, selectedId: value.avatarId }, tts: { ...tts, selectedId: voiceId, backend } }
}

/** 一次生命周期保存合并其它标签页的草稿，写入前统一做原生设置校验。 */
function mergeConfiguration(current: AssistantSettings, patch: unknown): AssistantSettings {
  if (patch === undefined) return current
  if (!Array.isArray(patch) || patch.length > 100) throw new Error('助理配置草稿无效')
  const next = structuredClone(current) as unknown as Record<string, any>
  for (const operation of patch) {
    const path = operation?.path
    if (!Array.isArray(path) || path.length < 1 || path.length > 3
      || !['appearance', 'voice', 'tts', 'prompts', 'notifications'].includes(path[0])
      || path.some((key) => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) || ['constructor', 'prototype'].includes(key))
      || !['set', 'unset'].includes(operation.op)) throw new Error('助理配置草稿字段无效')
    let target = next
    for (const key of path.slice(0, -1)) target = target[key] ??= {}
    if (operation.op === 'unset') delete target[path.at(-1)]
    else target[path.at(-1)] = structuredClone(operation.value)
  }
  return CodingNsSettingsSchema({ ...DEFAULT_CODINGNS_SETTINGS, assistant: next as unknown as AssistantSettings }).assistant
}

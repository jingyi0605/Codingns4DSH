import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsSettingsOperation, CodingNsSettingsSnapshot, CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'
import { sameSettingsValue } from '../../dsh-capabilities/settings-store.js'
import { readAssistantTtsSettings, MOSS_BUILTIN_VOICES, validateAssistantTtsParameters } from '../../shared/assistant-tts.js'
import type { AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import type { CodingNsClientServices, CodingNsRpcResult } from './types.js'
import { getGlobalVoiceAdapter, registerGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { getAssistantAvatarRegistry, bindAssistantAvatarRegistry } from '../avatar/registry.js'
import { getAssistantAvatarManager, bindAssistantAvatarManager, AssistantAvatarManager } from '../avatar/manager.js'
import { AssistantAvatarPortraitService, assistantAvatarPortraitOverrideStore, bindAssistantAvatarPortraitService, getAssistantAvatarPortraitService } from '../avatar/portrait-service.js'
import type { AssistantAvatarPreview } from '../avatar/preview-store.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarRenderer } from '../avatar/registry.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { hasAssistantAvatarConsent } from '../../shared/assistant-avatar-catalog.js'
import { findAssistantVoiceModel } from '../../shared/voice-models.js'
import { codingNsTranslator } from '../locale.js'

type ConfigurationSnapshot = CodingNsSettingsSnapshot<CodingNsSettings> & { readonly preparing: boolean }
const resourceActions = new Set(['assistant/tts/setup', 'assistant/tts/import', 'assistant/voice/setup', 'assistant/voice/initialize', 'avatar/install', 'avatar/installCatalog', 'avatar/installEngine'])

/** 配置窗口的唯一草稿存储；普通写入只修改内存，正式运行仍读原服务。 */
export class AssistantConfigurationSession implements CodingNsSettingsStore<CodingNsSettings> {
  readonly services: CodingNsClientServices
  private snapshot: ConfigurationSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly changes = new Map<string, CodingNsSettingsOperation>()
  private readonly portraits = new Map<string, { model: AssistantAvatarModel; renderer: AssistantAvatarRenderer | undefined; preview: AssistantAvatarPreview }>()
  private readonly portraitValues = new Map<string, AssistantAvatarPreview>()
  private readonly removedPortraits = new Set<string>()
  private readonly removals = new Map<string, { endpoint: string; payload: unknown }>()
  private readonly devices = new Map<'input' | 'output', string>()
  private releaseAdapter: (() => void) | undefined
  private preparationSupport: Promise<boolean> | undefined
  private preparations = 0
  private lifetime = new AbortController()
  private localRevision = 0

  constructor(private readonly original: CodingNsClientServices) {
    this.snapshot = { ...original.settings.getSnapshot(), value: structuredClone(original.settings.getSnapshot().value), revision: this.localRevision, preparing: false }
    this.services = { ...original, configurationDraft: true, settings: this, rpc: { call: (channel, endpoint, payload, signal) => this.call(channel, endpoint, payload, signal) } }
    bindAssistantAvatarRegistry(this.services, getAssistantAvatarRegistry(original))
    const overrides = {
      read: async (key: string, signal?: AbortSignal) => this.portraitValues.get(key) ?? await assistantAvatarPortraitOverrideStore.read(key, signal),
      write: async (key: string, id: string, _surface: unknown, preview: AssistantAvatarPreview, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        const model = getAssistantAvatarManager(this.services).list().find((item) => item.id === id)
        if (model === undefined) return false
        this.portraitValues.set(key, preview)
        this.portraits.set(key, { model, renderer: getAssistantAvatarRegistry(this.services).get(model.surfaces?.dialog?.renderer ?? model.renderer), preview })
        return true
      },
      removeModel: async (id: string) => { this.removedPortraits.add(id); for (const [key, item] of this.portraits) if (item.model.id === id) { this.portraits.delete(key); this.portraitValues.delete(key) } },
    }
    bindAssistantAvatarPortraitService(this.services, new AssistantAvatarPortraitService(undefined, undefined, undefined, undefined, undefined, overrides))
    bindAssistantAvatarManager(this.services, new AssistantAvatarManager(this, getAssistantAvatarManager(original).adapters, undefined, undefined, this.services.rpc,
      (id) => { this.removedPortraits.add(id) }))
    const adapter = getGlobalVoiceAdapter(original)
    if (adapter !== undefined) this.releaseAdapter = registerGlobalVoiceAdapter(this.services, new Proxy(adapter, { get: (target, key) => {
      if (key === 'selectInputDevice' || key === 'selectOutputDevice') return async (id: string) => { this.requireWritable(); this.devices.set(key === 'selectInputDevice' ? 'input' : 'output', id) }
      if (key === 'inputDeviceId' || key === 'outputDeviceId') return this.devices.get(key === 'inputDeviceId' ? 'input' : 'output') ?? Reflect.get(target, key)
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } }))
  }
  readonly getSnapshot = (): ConfigurationSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** 权威快照变化仅更新未编辑字段，后台状态刷新不能抹掉模型等草稿。 */
  sync(): void {
    const fresh = this.original.settings.getSnapshot()
    let value = structuredClone(fresh.value)
    if (value !== undefined) for (const operation of this.changes.values()) value = apply(value, operation)
    this.publish({ ...fresh, value, revision: this.localRevision })
  }
  reset(): void {
    this.lifetime.abort(); this.lifetime = new AbortController(); this.preparationSupport = undefined
    this.changes.clear(); this.portraits.clear(); this.portraitValues.clear(); this.removedPortraits.clear(); this.removals.clear(); this.devices.clear()
    getAssistantAvatarPortraitService(this.services).dispose()
    this.localRevision++; this.sync()
  }
  async mutate(operations: readonly CodingNsSettingsOperation[], expectedRevision?: number): Promise<boolean> {
    this.requireWritable()
    if (expectedRevision !== undefined && expectedRevision !== this.localRevision) throw new Error('settings namespace "assistant-draft" changed since it was read (expected revision)')
    for (const operation of operations) {
      if (operation.path[0] !== 'assistant' || operation.path.length < 2 || operation.path.length > 4
        || operation.path.some((key) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) || ['constructor', 'prototype'].includes(key))) throw new Error('配置草稿只允许修改助理字段')
    }
    let value = this.snapshot.value!
    for (const operation of operations) {
      value = apply(value, operation)
      const path = operation.path.join('.')
      // 父字段替换覆盖更早的子字段；重新编辑的字段排到末尾，刷新时按真实顺序重放。
      for (const key of this.changes.keys()) if (key === path || key.startsWith(path + '.')) this.changes.delete(key)
      this.changes.set(path, structuredClone(operation))
    }
    this.localRevision++; this.publish({ ...this.snapshot, value, revision: this.localRevision }); return true
  }
  async set(field: string, value: unknown): Promise<boolean> { return this.mutate([{ op: 'set', path: field.split('.'), value }]) }
  async unset(field: string): Promise<boolean> { return this.mutate([{ op: 'unset', path: field.split('.') }]) }
  async load(): Promise<void> { this.sync() }
  async reload(): Promise<void> { await this.original.settings.reload?.(); this.sync() }
  /** 身份字段由生命周期接口校验，其余字段同一请求合并保存。 */
  configurationPatch(): readonly CodingNsSettingsOperation[] {
    return [...this.changes.values()].filter((operation) => ['appearance', 'voice', 'tts', 'prompts'].includes(operation.path[1]!))
      .map((operation) => ({ ...operation, path: operation.path.slice(1) }))
  }
  async commitLocal(signal: AbortSignal): Promise<void> {
    for (const item of this.portraits.values()) await getAssistantAvatarPortraitService(this.original).setPortrait(item.model, item.renderer, item.preview, signal)
    const adapter = getGlobalVoiceAdapter(this.original)
    for (const [direction, id] of this.devices) { signal.throwIfAborted(); await (direction === 'input' ? adapter?.selectInputDevice(id) : adapter?.selectOutputDevice(id)) }
    for (const id of this.removedPortraits) getAssistantAvatarPortraitService(this.original).removeModel(id)
    for (const { endpoint, payload } of this.removals.values()) {
      const result = await this.original.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
    }
  }
  dispose(): void { this.lifetime.abort(); this.releaseAdapter?.(); getAssistantAvatarPortraitService(this.services).dispose(); this.listeners.clear() }
  private requireWritable(): void {
    if (!this.original.settings.getSnapshot().writable || !this.snapshot.writable || this.snapshot.status !== 'ready' || this.snapshot.value === undefined) throw new Error('当前助理配置不可写')
  }
  private publish(next: CodingNsSettingsSnapshot<CodingNsSettings>): void {
    const snapshot = { ...next, preparing: this.preparations > 0 }
    if (sameSettingsValue(this.snapshot, snapshot)) return
    this.snapshot = snapshot; for (const listener of this.listeners) listener()
  }
  private async call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<CodingNsRpcResult> {
    // 关闭后的租约释放仍必须发送，不能被草稿取消信号挡住。
    if (endpoint === 'avatar/releasePreview') return this.original.rpc.call(channel, endpoint, payload, signal)
    const ownedSignal = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const preparing = resourceActions.has(endpoint)
    if (preparing) { this.preparations++; this.publish(this.snapshot) }
    try { return await this.dispatch(channel, endpoint, payload, ownedSignal) }
    finally { if (preparing) { this.preparations--; this.publish(this.snapshot) } }
  }
  private async dispatch(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<CodingNsRpcResult> {
    signal?.throwIfAborted()
    const value = payload as Record<string, any> | undefined
    // 引擎安装同样属于资源准备：安装期间禁止保存，关闭窗口会取消请求。
    if (endpoint === 'avatar/installEngine') this.requireWritable()
    // 调试窗口的模型选择只用于显式测试，不提前改变正式索引的模型。
    if (endpoint === 'assistant/index/configure') return { ok: true, value: { configured: true } }
    // 当前窗口的同意立即用于浏览与准备素材，协议和形象选择仍随整份配置保存。
    if (['avatar/catalog', 'avatar/previewCatalog', 'avatar/keepPreview', 'avatar/installCatalog'].includes(endpoint)) {
      const thirdPartyConsent = this.snapshot.value?.assistant.appearance?.thirdPartyConsent
      if (!hasAssistantAvatarConsent(thirdPartyConsent)) return { ok: false, error: {
        code: 'CODINGNS_AVATAR_CONSENT_REQUIRED', message: codingNsTranslator(this.original.locale)('avatar.thirdPartyConsentRequired'),
      } }
      payload = { ...value, thirdPartyConsent }
    }
    if (endpoint === 'avatar/remove') { this.requireWritable(); this.removals.set(endpoint + ':' + String(value?.id), { endpoint, payload }); return { ok: true, value: undefined } }
    if (['assistant/tts/select', 'assistant/tts/configure', 'assistant/tts/remove'].includes(endpoint)) {
      const tts = readAssistantTtsSettings(this.snapshot.value!.assistant.tts)
      const next = endpoint.endsWith('/configure') ? { ...tts, parameters: validateAssistantTtsParameters(value?.parameters, tts.parameters) }
        : endpoint.endsWith('/remove') ? { ...tts, voices: tts.voices.filter((voice) => voice.id !== value?.id), selectedId: tts.selectedId === value?.id ? 'moss:Junhao' : tts.selectedId }
          : { ...tts, selectedId: value?.id ?? tts.selectedId, backend: value?.backend === 'browser' ? 'browser' as const : 'moss-onnx' as const }
      await this.set('assistant.tts', next)
      return this.call(channel, 'assistant/tts/catalog', {}, signal)
    }
    const preparing = ['assistant/tts/setup', 'assistant/tts/import', 'assistant/voice/setup', 'assistant/voice/initialize'].includes(endpoint)
    if (preparing) {
      this.requireWritable()
      // 旧 Host 可能忽略 prepareOnly，先确认能力，不能静默退回立即启用。
      this.preparationSupport ??= this.original.rpc.call(channel, 'assistant/configuration/capabilities', {}, signal)
        .then((response) => response.ok && (response.value as { prepareOnly?: boolean })?.prepareOnly === true)
      if (!await this.preparationSupport) {
        const t = codingNsTranslator(this.original.locale)
        return { ok: false, error: { code: 'UNSUPPORTED', message: t('awb.preparationUnsupported') } }
      }
      signal?.throwIfAborted()
    }
    const preparedModelId = endpoint === 'assistant/voice/initialize' ? findAssistantVoiceModel(this.snapshot.value!.assistant.voice.modelId ?? '')?.id : undefined
    const result = await this.original.rpc.call(channel, endpoint, preparing ? { ...value, ...(preparedModelId === undefined ? {} : { modelId: preparedModelId }), prepareOnly: true } : payload, signal)
    signal.throwIfAborted()
    if (!result.ok) return result
    if (preparing) {
      const prepared = result.value as any
      if (endpoint === 'assistant/voice/setup' && prepared.voice !== undefined) await this.set('assistant.voice', prepared.voice)
      if (endpoint === 'assistant/voice/initialize') {
        if (prepared.voice !== undefined) await this.set('assistant.voice', prepared.voice)
        await this.set('assistant.tts', { ...readAssistantTtsSettings(this.snapshot.value!.assistant.tts), backend: 'moss-onnx' })
      }
      if (endpoint === 'assistant/tts/setup') await this.set('assistant.tts', { ...readAssistantTtsSettings(this.snapshot.value!.assistant.tts), backend: 'moss-onnx' })
      if (endpoint === 'assistant/tts/import') {
        const current = readAssistantTtsSettings(this.snapshot.value!.assistant.tts), incoming = (prepared as AssistantTtsSnapshot).settings
        const voices = new Map([...current.voices, ...incoming.voices].map((voice) => [voice.id, voice]))
        await this.set('assistant.tts', { ...current, ...incoming, voices: [...voices.values()] })
      }
    }
    if (endpoint.startsWith('assistant/tts/') && (result.value as any)?.settings !== undefined) {
      const raw = this.snapshot.value!.assistant.tts
      const settings = { ...readAssistantTtsSettings(raw), ...(raw?.parameters === undefined ? {} : { parameters: raw.parameters }) }
      return { ok: true, value: { ...(result.value as AssistantTtsSnapshot), settings, voices: [...MOSS_BUILTIN_VOICES, ...settings.voices] } }
    }
    if (endpoint === 'assistant/voice/initialization' || endpoint === 'assistant/voice/initialize') {
      const snapshot = result.value as any, settings = readAssistantTtsSettings(this.snapshot.value!.assistant.tts), voice = this.snapshot.value!.assistant.voice
      const model = findAssistantVoiceModel(voice.modelId ?? '')
      return { ok: true, value: { ...snapshot, modelId: voice.modelId || snapshot.modelId, modelLabel: model?.label ?? snapshot.modelLabel,
        ready: voice.initialized && snapshot.tts.status.ready && settings.backend === 'moss-onnx',
        tts: { ...snapshot.tts, settings, voices: [...MOSS_BUILTIN_VOICES, ...settings.voices] } } }
    }
    return result
  }
}
function apply(value: CodingNsSettings, operation: CodingNsSettingsOperation): CodingNsSettings {
  const next = structuredClone(value), path = operation.path, root = next as unknown as Record<string, any>
  let target = root
  for (const key of path.slice(0, -1)) target = target[key] ??= {}
  if (operation.op === 'unset') delete target[path.at(-1)!]
  else target[path.at(-1)!] = structuredClone(operation.value)
  return next
}

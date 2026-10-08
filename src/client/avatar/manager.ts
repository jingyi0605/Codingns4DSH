import { BUILTIN_ASSISTANT_AVATAR, getBuiltinAssistantAvatar, copyAssistantAvatarModel, isAssistantAvatarSource, listAssistantAvatars, normalizeAssistantAppearance, selectedAssistantAvatar,
  validateAssistantAppearance, validateAssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { AssistantAppearanceSettings, AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { BUILTIN_ASSISTANT_AVATAR_ADAPTERS } from '../../shared/assistant-avatar-adapters.js'
import type { AssistantAvatarAdapter } from '../../shared/assistant-avatar-adapters.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'
import { sameSettingsValue } from '../../dsh-capabilities/settings-store.js'
import type { CodingNsClientServices } from '../features/types.js'
import { AssistantAvatarRegistration } from './registration.js'
import { assistantAvatarPreviewStore } from './preview-store.js'
import { assistantAvatarPortraitStore, assistantAvatarPortraitOverrideStore, getAssistantAvatarPortraitService } from './portrait-service.js'
import type { CodingNsRpcClient } from '../features/types.js'
import type { AssistantAvatarCandidate, AssistantAvatarInstallation } from '../../shared/assistant-avatar-installation.js'
import { ASSISTANT_AVATAR_CONSENT_VERSION, hasAssistantAvatarConsent } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarCatalogEntry, AssistantAvatarTemporaryPreview } from '../../shared/assistant-avatar-catalog.js'
import { ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, hasAssistantAvatarEngineConsent } from '../../shared/assistant-avatar-engine.js'
import type { AssistantAvatarEngineStatus } from '../../shared/assistant-avatar-engine.js'

export class AssistantAvatarAdapterRegistry extends AssistantAvatarRegistration<AssistantAvatarAdapter> {
  constructor() { super(BUILTIN_ASSISTANT_AVATAR_ADAPTERS) }
  parse(manifest: unknown, manifestUrl: string, adapterId = 'auto'): AssistantAvatarModel {
    const adapter = adapterId === 'auto' ? this.getSnapshot().find((item) => item.matches(manifest)) : this.get(adapterId)
    if (adapter === undefined || !adapter.matches(manifest)) throw new TypeError('无法识别形象包，或所选适配器未注册')
    const model = adapter.parse(manifest, { manifestUrl })
    const result = { ...model, package: { ...model.package, adapterId: adapter.id, manifestUrl } }
    validateAssistantAvatarModel(result)
    return copyAssistantAvatarModel(result)
  }
}

export type AssistantAppearanceUpdate = Partial<Pick<AssistantAppearanceSettings, 'floatingEnabled' | 'dialogEnabled' | 'floatingSize' | 'dialogSize'>>

/** 唯一写入入口：包导入与手工素材最终都变成同一清单，不拥有语音或会话。 */
export class AssistantAvatarManager {
  private writes: Promise<unknown> = Promise.resolve()
  private appearance: AssistantAppearanceSettings | undefined
  private catalog: readonly AssistantAvatarModel[] = []
  constructor(private readonly settings: CodingNsSettingsStore<CodingNsSettings>,
    readonly adapters = new AssistantAvatarAdapterRegistry(),
    private readonly fetchManifest: typeof fetch = (...args) => fetch(...args),
    private readonly baseUrl: string | undefined = typeof location === 'undefined' ? undefined : location.href,
    private readonly rpc?: CodingNsRpcClient,
    private readonly removePortrait: (id: string) => void = (id) => {
      void assistantAvatarPortraitStore.removeModel(id).catch(() => undefined)
      void assistantAvatarPortraitOverrideStore.removeModel(id).catch(() => undefined)
    }) {}

  /** React 和扩展都可以订阅这一份稳定快照，语音设置变化不会刷新形象列表。 */
  readonly getSnapshot = (): AssistantAppearanceSettings => {
    const next = normalizeAssistantAppearance(this.settings.getSnapshot().value?.assistant.appearance)
    if (this.appearance === undefined || !sameSettingsValue(this.appearance, next)) {
      this.appearance = next
      this.catalog = Object.freeze(listAssistantAvatars(next))
    }
    return this.appearance
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    let previous = this.getSnapshot()
    return this.settings.subscribe(() => {
      const next = this.getSnapshot()
      if (previous === next) return
      previous = next; listener()
    })
  }
  getAppearance(): AssistantAppearanceSettings { return this.getSnapshot() }
  list(): readonly AssistantAvatarModel[] { this.getSnapshot(); return this.catalog }
  getSelected(): AssistantAvatarModel { return selectedAssistantAvatar(this.getAppearance()) }

  select(id: string): Promise<void> {
    return this.write((current) => { this.requireModel(current, id); return { ...current, selectedId: id } })
  }
  async add(model: AssistantAvatarModel): Promise<void> {
    validateAssistantAvatarModel(model)
    const copy = copyAssistantAvatarModel(model)
    return this.insert(copy)
  }
  async update(model: AssistantAvatarModel): Promise<void> {
    this.requireCustom(model.id); validateAssistantAvatarModel(model)
    const copy = copyAssistantAvatarModel(model)
    return this.write((current) => {
      this.requireModel(current, copy.id)
      return { ...current, models: current.models.some((item) => item.id === copy.id)
        ? current.models.map((item) => item.id === copy.id ? copy : item) : [...current.models, copy] }
    })
  }
  async remove(id: string): Promise<void> {
    this.requireCustom(id)
    const installation = this.list().find((model) => model.id === id)?.package?.installationId
    await this.write((current) => { this.requireModel(current, id); return { ...current,
      selectedId: current.selectedId === id ? BUILTIN_ASSISTANT_AVATAR.id : current.selectedId,
      models: current.models.filter((item) => item.id !== id) } })
    void assistantAvatarPreviewStore.removeModel(id).catch(() => undefined)
    this.removePortrait(id)
    if (installation !== undefined && !this.list().some((model) => model.package?.installationId === installation)) {
      await this.call('remove', { id: installation })
    }
  }
  async configure(update: AssistantAppearanceUpdate): Promise<void> {
    if (Object.keys(update).some((key) => !['floatingEnabled', 'dialogEnabled', 'floatingSize', 'dialogSize'].includes(key))) throw new TypeError('展示设置字段无效')
    return this.write((current) => ({ ...current, ...update }))
  }

  /** 必须从独立协议操作调用；展示配置不会隐式开启第三方目录。 */
  setThirdPartyEnabled(enabled: boolean): Promise<void> {
    return this.write((current) => {
      const { thirdPartyConsent: _previous, ...appearance } = current
      return enabled ? { ...appearance, thirdPartyConsent: { version: ASSISTANT_AVATAR_CONSENT_VERSION, acceptedAt: Date.now() } } : appearance
    })
  }
  /** 引擎许可与第三方素材协议分开记录；撤销同意不卸载已安装引擎。 */
  setEngineEnabled(enabled: boolean): Promise<void> {
    return this.write((current) => {
      const { engineConsent: _previous, ...appearance } = current
      return enabled ? { ...appearance, engineConsent: { version: ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, acceptedAt: Date.now() } } : appearance
    })
  }
  /** 只读探测；已确认许可后由安装接口写入 CodingNS 自有引擎目录。 */
  async engineStatus(signal?: AbortSignal): Promise<AssistantAvatarEngineStatus> {
    return readEngineStatus(await this.call('engineStatus', {}, signal))
  }
  async installEngine(signal?: AbortSignal): Promise<AssistantAvatarEngineStatus> {
    this.requireWritable(); this.requireEngineConsent(); signal?.throwIfAborted()
    return readEngineStatus(await this.call('installEngine', {}, signal))
  }
  async getCatalog(signal?: AbortSignal): Promise<readonly AssistantAvatarCatalogEntry[]> {
    this.requireConsent(); signal?.throwIfAborted()
    return this.call('catalog', {}, signal) as Promise<readonly AssistantAvatarCatalogEntry[]>
  }
  async previewCatalog(id: string, revision: string, lease: string, signal?: AbortSignal): Promise<AssistantAvatarTemporaryPreview> {
    this.requireWritable(); this.requireConsent(); signal?.throwIfAborted()
    const result = await this.call('previewCatalog', { id, revision, lease }, signal) as AssistantAvatarTemporaryPreview
    validateAssistantAvatarModel(result.model)
    if (result.lease !== lease) throw new TypeError('临时形象预览标识不一致')
    return result
  }
  async releasePreview(lease: string): Promise<void> { await this.call('releasePreview', { lease }) }
  async keepPreview(lease: string): Promise<void> { await this.call('keepPreview', { lease }) }
  async installCatalog(id: string, revision: string, licenseAccepted: boolean, signal?: AbortSignal, lease?: string): Promise<AssistantAvatarModel> {
    this.requireWritable(); this.requireConsent(); signal?.throwIfAborted()
    if (!licenseAccepted) throw new TypeError('请确认所选形象的许可及应用')
    const installed = await this.call('installCatalog', { id, revision, licenseAccepted, ...(lease === undefined ? {} : { lease }) }, signal) as AssistantAvatarInstallation
    return this.registerInstallation(installed, signal, true)
  }

  /** 只读清单 JSON；网络/解析/取消失败都不新增形象，不修改当前选择。 */
  async importPackage(source: string, adapterId = 'auto', signal?: AbortSignal): Promise<AssistantAvatarModel> {
    this.requireWritable(); signal?.throwIfAborted()
    if (!isAssistantAvatarSource(source)) throw new TypeError('形象包清单地址无效')
    const url = new URL(source, this.baseUrl).href
    const response = await this.fetchManifest(url, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) })
    if (!response.ok) throw new Error(`avatar_manifest_http_${response.status}`)
    const text = await response.text()
    if (text.length > 262144) throw new TypeError('形象包清单过大')
    signal?.throwIfAborted()
    const model = this.adapters.parse(JSON.parse(text), response.url || url, adapterId)
    await this.insert(model, signal)
    return model
  }

  /** 新入口在 Host 安装完整素材后才写入形象列表；旧外链导入 API 保持兼容。 */
  async discover(source: string, signal?: AbortSignal): Promise<readonly AssistantAvatarCandidate[]> {
    this.requireWritable(); signal?.throwIfAborted()
    return this.call('discover', { source }, signal) as Promise<readonly AssistantAvatarCandidate[]>
  }
  async installPackage(source: string, adapterId = 'auto', signal?: AbortSignal): Promise<AssistantAvatarModel> {
    this.requireWritable(); signal?.throwIfAborted()
    const installed = await this.call('install', { source, adapterId }, signal) as AssistantAvatarInstallation
    return this.registerInstallation(installed, signal)
  }
  private async registerInstallation(installed: AssistantAvatarInstallation, signal?: AbortSignal, fromCatalog = false): Promise<AssistantAvatarModel> {
    let replacedInstallation: string | undefined
    try {
      validateAssistantAvatarModel(installed.model)
      await this.write((current) => {
        signal?.throwIfAborted()
        if (fromCatalog && !hasAssistantAvatarConsent(current.thirdPartyConsent)) throw new TypeError('第三方形象列表已关闭')
        const existing = current.models.find((model) => model.id === installed.model.id)
        replacedInstallation = existing?.package?.installationId
        const sameSource = existing?.package?.manifestUrl !== undefined && existing.package.manifestUrl === installed.model.package?.manifestUrl
        if (existing !== undefined && existing.package?.installationId !== installed.id && !sameSource) throw new TypeError('形象 ID 已存在，请先移除已有记录')
        if (installed.model.package?.installationId !== installed.id || !/^[a-f0-9]{64}$/u.test(installed.id)) throw new TypeError('形象安装结果无效')
        return { ...current, selectedId: installed.model.id,
          models: existing === undefined ? [...current.models, installed.model] : current.models.map((model) => model.id === existing.id ? installed.model : model) }
      })
      // 新版本成功启用后再回收旧版本；清理失败不推翻已经保存的有效选择。
      if (replacedInstallation !== undefined && replacedInstallation !== installed.id
        && !this.list().some((model) => model.package?.installationId === replacedInstallation)) {
        await this.call('remove', { id: replacedInstallation }).catch(() => undefined)
      }
      return installed.model
    } catch (error) {
      // 只清理本次新建的素材，不删除其他窗口已成功启用的同版本资源。
      if (installed.created && !this.list().some((model) => model.package?.installationId === installed.id)) await this.call('remove', { id: installed.id }).catch(() => undefined)
      throw error
    }
  }
  private async call(action: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.rpc === undefined) throw new Error('形象本地安装服务不可用')
    const result = await this.rpc.call(CODINGNS_RPC_CHANNEL, `avatar/${action}`, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  private insert(model: AssistantAvatarModel, signal?: AbortSignal): Promise<void> {
    this.requireCustom(model.id)
    return this.write((current) => {
      signal?.throwIfAborted()
      if (current.models.some((item) => item.id === model.id)) throw new TypeError('形象 ID 已存在，请更新已有形象或使用其他 ID')
      return { ...current, selectedId: model.id, models: [...current.models, model] }
    })
  }

  private write(update: (current: AssistantAppearanceSettings) => AssistantAppearanceSettings): Promise<void> {
    // 公开 API 可以并发调用，后一项必须读取前一项保存后的清单和 revision。
    const task = this.writes.then(() => this.saveAppearance(update))
    this.writes = task.catch(() => undefined)
    return task
  }

  private async saveAppearance(update: (current: AssistantAppearanceSettings) => AssistantAppearanceSettings): Promise<void> {
    // revision 属于整个命名空间，后台会话索引也会推进它；冲突后必须重算改动，
    // 不能撤掉版本校验或重放旧 appearance，否则会覆盖其他窗口刚保存的形象。
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = this.requireWritable()
      const current = normalizeAssistantAppearance(snapshot.value!.assistant.appearance)
      const next = update(current)
      validateAssistantAppearance(next)
      if (JSON.stringify(next) === JSON.stringify(current)) return
      try {
        const accepted = await this.settings.mutate([{ op: 'set', path: ['assistant', 'appearance'], value: next }], snapshot.revision)
        if (!accepted) throw new Error('形象设置保存被拒绝，请刷新后重试')
        return
      } catch (error) {
        if (!isSettingsConflict(error) || this.settings.reload === undefined) throw error
        if (attempt === 2) throw new Error('形象设置持续被其他操作更新，请稍后重试', { cause: error })
        await this.settings.reload()
      }
    }
  }
  private requireWritable() {
    const snapshot = this.settings.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) throw new Error('形象设置尚未就绪')
    if (!snapshot.writable) throw new Error('当前形象设置为只读')
    return snapshot
  }
  private requireConsent(): void {
    if (!hasAssistantAvatarConsent(this.getAppearance().thirdPartyConsent)) throw new TypeError('请先同意第三方形象使用说明')
  }
  private requireEngineConsent(): void {
    if (!hasAssistantAvatarEngineConsent(this.getAppearance().engineConsent)) throw new TypeError('请先确认 Live2D 引擎许可')
  }
  private requireModel(current: AssistantAppearanceSettings, id: string): void {
    if (!listAssistantAvatars(current).some((item) => item.id === id)) throw new TypeError('形象不在清单中')
  }
  private requireCustom(id: string): void {
    if (getBuiltinAssistantAvatar(id) !== undefined) throw new TypeError('内置形象不可替换或删除')
  }
}

/** 引擎状态来自 Host；形状异常按不可用处理，避免把坏数据当成就绪。 */
function readEngineStatus(value: unknown): AssistantAvatarEngineStatus {
  const status = value as AssistantAvatarEngineStatus | null
  if (status === null || typeof status !== 'object' || typeof status.installed !== 'boolean'
    || typeof status.version !== 'string' || !['managed', 'dependency', 'missing'].includes(status.source)) {
    throw new TypeError('Live2D 引擎状态无效')
  }
  return { installed: status.installed, version: status.version, source: status.source }
}

/** 兼容原生异常、RPC 稳定错误码，以及旧 Host 只透传正文的响应。 */
function isSettingsConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const failure = error as { readonly code?: unknown; readonly name?: unknown; readonly message?: unknown }
  return failure.code === 'SETTINGS_CONFLICT' || failure.code === 'SettingsConflictError'
    || failure.name === 'SettingsConflictError'
    || (typeof failure.message === 'string' && /^settings namespace ".+" changed since it was read \(expected revision /u.test(failure.message))
}

const managers = new WeakMap<CodingNsClientServices, AssistantAvatarManager>()
export function bindAssistantAvatarManager(services: CodingNsClientServices, manager: AssistantAvatarManager): void { managers.set(services, manager) }
export function getAssistantAvatarManager(services: CodingNsClientServices): AssistantAvatarManager {
  let manager = managers.get(services)
  if (manager === undefined) {
    manager = new AssistantAvatarManager(services.settings, undefined, undefined, undefined, services.rpc,
      (id) => getAssistantAvatarPortraitService(services).removeModel(id))
    managers.set(services, manager)
  }
  return manager
}
/** 扩展应将注销函数登记到 context.resources，已导入的数据不会随适配器注销丢失。 */
export function registerAssistantAvatarAdapter(services: CodingNsClientServices, adapter: AssistantAvatarAdapter): () => void {
  return getAssistantAvatarManager(services).adapters.register(adapter)
}

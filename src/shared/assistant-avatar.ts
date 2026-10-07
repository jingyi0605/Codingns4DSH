import { getAssistantAvatarPreset } from './assistant-avatar-legacy.js'
import { validAssistantAvatarConsent } from './assistant-avatar-catalog.js'
import type { AssistantAvatarConsent } from './assistant-avatar-catalog.js'

/** 形象只消费助理状态，不持有会话、语音设备或工作区权限。 */
export type AssistantAvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'error'
export type AssistantAvatarSurface = 'floating' | 'dialog'

export const ASSISTANT_AVATAR_STATES: readonly AssistantAvatarState[] = ['idle', 'listening', 'thinking', 'speaking', 'waiting', 'error']

/** 素材与角色身份分开，同一个包可以为两个展示位置提供不同素材。 */
export interface AssistantAvatarAsset {
  /** 内置 ID 为 builtin/image/spritesheet/live2d；其他 ID 由扩展注册。 */
  readonly renderer: string
  readonly source: string
  readonly spriteVersion: 1 | 2
  /** 图片差分按统一助理状态选择，未声明的状态使用 source。 */
  readonly stateSources?: Readonly<Partial<Record<AssistantAvatarState, string>>>
  /** Live2D 动作组显式映射，未声明的状态保留自动识别与待机回落。 */
  readonly motionGroups?: Readonly<Partial<Record<AssistantAvatarState, string>>>
  /** 模型自适应后再应用包内缩放和位置，适配不同模型的构图。 */
  readonly live2d?: { readonly scale?: number; readonly position?: readonly [number, number] }
}
export interface AssistantAvatarPackageInfo {
  readonly adapterId: string
  readonly manifestUrl?: string
  readonly author?: string
  readonly license?: string
  readonly homepage?: string
  /** 本地素材安装的内容版本；不持有渲染实例或绝对磁盘路径。 */
  readonly installationId?: string
}
export interface AssistantAvatarModel extends AssistantAvatarAsset {
  readonly id: string
  readonly name: string
  readonly package?: AssistantAvatarPackageInfo
  readonly surfaces?: Readonly<Partial<Record<AssistantAvatarSurface, AssistantAvatarAsset>>>
}
/** CodingNS 原生包清单；其他格式由适配器转换后使用相同的存储与展示接口。 */
export interface AssistantAvatarManifest {
  readonly avatarManifestVersion: 1
  readonly id: string
  readonly name: string
  readonly asset: AssistantAvatarAsset
  readonly surfaces?: AssistantAvatarModel['surfaces']
  readonly author?: string
  readonly license?: string
  readonly homepage?: string
}

export interface AssistantAppearanceSettings {
  readonly floatingEnabled: boolean
  readonly dialogEnabled: boolean
  readonly floatingSize: number
  readonly dialogSize: number
  readonly selectedId: string
  readonly models: readonly AssistantAvatarModel[]
  /** 仅控制第三方目录访问，撤销同意不会删除已安装形象。 */
  readonly thirdPartyConsent?: AssistantAvatarConsent
}

export const ASSISTANT_AVATAR_RUNTIME_PATH = '/api/codingns/assistant-avatar-runtime'
/** 尺寸档位只映射到既有数值字段，旧自定义尺寸无需迁移。 */
export const ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE = 144
export const ASSISTANT_AVATAR_FLOATING_MINI_SIZE = ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE / 2
export const BUILTIN_ASSISTANT_AVATAR: AssistantAvatarModel = {
  id: 'codingns-default', name: '鱼妞', renderer: 'builtin', source: '', spriteVersion: 2,
}
/** 保留旧默认 ID 和存储字段；实际生图素材通过固定的同源 URL 加载。 */
export const BUILTIN_ASSISTANT_AVATARS: readonly AssistantAvatarModel[] = [BUILTIN_ASSISTANT_AVATAR,
  { id: 'codingns-basic-male', name: '鱼仔', renderer: 'builtin', source: '', spriteVersion: 2 }]
/** 旧名称仅用于写入兼容；读取归一化后统一显示新名称，其他内置字段仍不可替换。 */
const legacyBuiltinNames: Readonly<Record<string, string>> = {
  'codingns-default': 'CodingNS', 'codingns-basic-male': '基础形象 · 男生',
}
export const BUILTIN_ASSISTANT_AVATAR_SOURCES: Readonly<Record<string, string>> = {
  'codingns-default': '/api/codingns/assistant-avatar-basic/female-v1.png',
  'codingns-basic-male': '/api/codingns/assistant-avatar-basic/male-v1.png',
}
/** 两个基础形象加原有的 19 个自定义名额，升级时不会丢掉已登记角色。 */
export const ASSISTANT_AVATAR_MAX_MODELS = 21
export function getBuiltinAssistantAvatar(id: unknown): AssistantAvatarModel | undefined {
  return BUILTIN_ASSISTANT_AVATARS.find((model) => model.id === id)
}
export function builtinAssistantAvatarLabelKey(id: string): string | undefined {
  if (id === BUILTIN_ASSISTANT_AVATAR.id) return 'avatar.builtinName'
  if (id === 'codingns-basic-male') return 'avatar.builtinMaleName'
  return undefined
}
export const DEFAULT_ASSISTANT_APPEARANCE: AssistantAppearanceSettings = {
  floatingEnabled: false, dialogEnabled: true, floatingSize: ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE, dialogSize: 240,
  selectedId: BUILTIN_ASSISTANT_AVATAR.id, models: BUILTIN_ASSISTANT_AVATARS,
}

/** 资源只允许网页地址；任意脚本、file: 和协议相对地址均不能作为素材入口。 */
export function isAssistantAvatarSource(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || /[\s\\\u0000-\u001f]/u.test(value)) return false
  if (value.startsWith('/') && !value.startsWith('//')) return true
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  } catch { return false }
}

/** 读取旧设置时补默认值；非法模型被过滤，绝不让坏配置阻止助理入口。 */
export function normalizeAssistantAppearance(value: unknown): AssistantAppearanceSettings {
  const record = asRecord(value)
  const models = [...BUILTIN_ASSISTANT_AVATARS]
  const seen = new Set(models.map((model) => model.id))
  for (const item of Array.isArray(record.models) ? record.models.slice(0, ASSISTANT_AVATAR_MAX_MODELS) : []) {
    if (models.length >= ASSISTANT_AVATAR_MAX_MODELS) break
    const model = asRecord(item)
    if (!validModel(model) || seen.has(model.id as string)) continue
    seen.add(model.id as string)
    models.push(copyAssistantAvatarModel(model as unknown as AssistantAvatarModel))
  }
  return {
    floatingEnabled: record.floatingEnabled === true,
    dialogEnabled: record.dialogEnabled !== false,
    floatingSize: boundedSize(record.floatingSize, ASSISTANT_AVATAR_FLOATING_MINI_SIZE, 320, ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE),
    dialogSize: boundedSize(record.dialogSize, 120, 480, 240),
    selectedId: typeof record.selectedId === 'string' && (seen.has(record.selectedId) || getAssistantAvatarPreset(record.selectedId) !== undefined) ? record.selectedId : BUILTIN_ASSISTANT_AVATAR.id,
    models,
    ...(validAssistantAvatarConsent(record.thirdPartyConsent) ? { thirdPartyConsent: {
      version: record.thirdPartyConsent.version, acceptedAt: record.thirdPartyConsent.acceptedAt } } : {}),
  }
}

/** 写入必须严格校验，不能把被静默修正的数据报告为保存成功。 */
export function validateAssistantAppearance(value: unknown): void {
  const record = asRecord(value)
  if (record.thirdPartyConsent !== undefined && !validAssistantAvatarConsent(record.thirdPartyConsent)) throw new TypeError('第三方形象协议记录无效')
  if (typeof record.floatingEnabled !== 'boolean' || typeof record.dialogEnabled !== 'boolean') throw new TypeError('形象显示开关无效')
  for (const [key, min, max] of [['floatingSize', ASSISTANT_AVATAR_FLOATING_MINI_SIZE, 320], ['dialogSize', 120, 480]] as const) {
    if (typeof record[key] !== 'number' || !Number.isInteger(record[key]) || record[key] < min || record[key] > max) throw new TypeError('形象尺寸超出范围')
  }
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > ASSISTANT_AVATAR_MAX_MODELS) throw new TypeError(`形象清单必须包含 1 到 ${ASSISTANT_AVATAR_MAX_MODELS} 项`)
  const seen = new Set<string>()
  for (const item of record.models) {
    const model = asRecord(item)
    validateAssistantAvatarModel(model)
    if (typeof model.id !== 'string' || seen.has(model.id)) throw new TypeError('形象 ID 重复或无效')
    seen.add(model.id)
  }
  if (!seen.has(BUILTIN_ASSISTANT_AVATAR.id) || typeof record.selectedId !== 'string'
    || (!seen.has(record.selectedId) && getAssistantAvatarPreset(record.selectedId) === undefined)) throw new TypeError('当前形象不在清单中')
}

/** 所有导入和管理写入共享同一校验，不能由某个适配器绕过资源边界。 */
export function validateAssistantAvatarModel(value: unknown): asserts value is AssistantAvatarModel {
  const model = asRecord(value)
  const builtin = getBuiltinAssistantAvatar(model.id)
  if (builtin !== undefined) {
    const keys = Object.keys(builtin) as (keyof AssistantAvatarModel)[]
    if (keys.some((key) => model[key] !== builtin[key] && !(key === 'name' && model[key] === legacyBuiltinNames[builtin.id]))
      || Object.keys(model).some((key) => !keys.includes(key as keyof AssistantAvatarModel) && model[key] !== undefined)) throw new TypeError('内置形象不可替换')
    return
  }
  if (!validModel(model)) throw new TypeError('形象名称、类型或资源地址无效')
}

/** 保留旧存储字段，复制白名单内的数据，避免扩展把运行对象写进设置。 */
export function copyAssistantAvatarModel(model: AssistantAvatarModel): AssistantAvatarModel {
  return { id: model.id, name: model.name.trim(), ...copyAsset(model),
    ...(model.package === undefined ? {} : { package: { ...model.package } }),
    ...(model.surfaces === undefined ? {} : { surfaces: Object.fromEntries(Object.entries(model.surfaces).map(([surface, asset]) => [surface, copyAsset(asset)])) }),
  }
}

export function selectedAssistantAvatar(appearance: AssistantAppearanceSettings): AssistantAvatarModel {
  return appearance.models.find((model) => model.id === appearance.selectedId)
    ?? getAssistantAvatarPreset(appearance.selectedId)?.model ?? BUILTIN_ASSISTANT_AVATAR
}

/** 创建表单只列已登记形象；已创建助理和管理器可保留旧选择的兼容入口。 */
export function listAssistantAvatars(appearance: AssistantAppearanceSettings, includeLegacy = true): readonly AssistantAvatarModel[] {
  if (!includeLegacy) return appearance.models
  const legacy = getAssistantAvatarPreset(appearance.selectedId)?.model
  return legacy === undefined || appearance.models.some((model) => model.id === legacy.id)
    ? appearance.models : [...appearance.models, legacy]
}

/** 展示位置只覆盖素材，不覆盖身份；状态映射也跟随所选素材，不串用另一种格式。 */
export function resolveAssistantAvatarAsset(model: AssistantAvatarModel, surface: AssistantAvatarSurface): AssistantAvatarModel {
  const asset = model.surfaces?.[surface]
  return asset === undefined ? model : { id: model.id, name: model.name, ...copyAsset(asset),
    ...(model.package === undefined ? {} : { package: model.package }), ...(model.surfaces === undefined ? {} : { surfaces: model.surfaces }) }
}

export function assistantAvatarImageSource(model: AssistantAvatarAsset, state: AssistantAvatarState): string {
  return model.stateSources?.[state] ?? model.source
}

export function resolveAssistantAvatarState(state: string | undefined, pending = false): AssistantAvatarState {
  if (state === 'error') return 'error'
  if (state === 'speaking') return 'speaking'
  if (pending || state === 'loading' || state === 'thinking') return 'thinking'
  if (state === 'listening' || state === 'recording') return 'listening'
  if (state === 'waiting') return 'waiting'
  return 'idle'
}

export interface AssistantSpriteMotion { readonly row: number; readonly frames: number; readonly interval: number }

/** 帧布局来自 Signalight/codex-to-dsh-pet；单帧 192×208，8 列。 */
export function assistantSpriteMotion(state: AssistantAvatarState): AssistantSpriteMotion {
  if (state === 'error') return { row: 5, frames: 8, interval: 140 }
  if (state === 'waiting' || state === 'listening') return { row: 6, frames: 6, interval: 150 }
  if (state === 'thinking') return { row: 7, frames: 6, interval: 120 }
  if (state === 'speaking') return { row: 8, frames: 6, interval: 150 }
  return { row: 0, frames: 6, interval: 160 }
}

/** 视口变化或旧坐标失效时让宠物保持在可点击范围。 */
export function clampAssistantAvatarPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(Number.isFinite(x) ? x : 0, Math.max(0, viewportWidth - width))),
    y: Math.max(0, Math.min(Number.isFinite(y) ? y : 0, Math.max(0, viewportHeight - height))) }
}

function validModel(model: Record<string, unknown>): boolean {
  return typeof model.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(model.id)
    && typeof model.name === 'string' && model.name.trim().length > 0 && model.name.length <= 80
    && validAsset(model) && validPackage(model.package) && validSurfaces(model.surfaces)
}
function validAsset(asset: Record<string, unknown>): boolean {
  return typeof asset.renderer === 'string' && validId(asset.renderer) && asset.renderer !== 'builtin'
    && typeof asset.source === 'string' && isAssistantAvatarSource(asset.source)
    && (asset.spriteVersion === 1 || asset.spriteVersion === 2)
    && validStateMap(asset.stateSources, (source) => asset.renderer === 'image' && isAssistantAvatarSource(source))
    && validStateMap(asset.motionGroups, (group) => asset.renderer === 'live2d' && group.trim().length > 0 && group.length <= 120)
    && validLive2dOptions(asset.live2d, asset.renderer)
}
function validStateMap(value: unknown, valid: (value: string) => boolean): boolean {
  return value === undefined || (isRecord(value) && Object.entries(value).every(([state, item]) =>
    ASSISTANT_AVATAR_STATES.includes(state as AssistantAvatarState) && typeof item === 'string' && valid(item)))
}
function validPackage(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || typeof value.adapterId !== 'string' || !validId(value.adapterId)) return false
  for (const key of ['manifestUrl', 'homepage']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !isAssistantAvatarSource(value[key]))) return false
  for (const key of ['author', 'license']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 2048)) return false
  if (value.installationId !== undefined && (typeof value.installationId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.installationId))) return false
  return Object.keys(value).every((key) => ['adapterId', 'manifestUrl', 'homepage', 'author', 'license', 'installationId'].includes(key))
}
function validSurfaces(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.entries(value).every(([surface, asset]) =>
    ['floating', 'dialog'].includes(surface) && isRecord(asset) && validAsset(asset)))
}
function validLive2dOptions(value: unknown, renderer: string): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || renderer !== 'live2d' || Object.keys(value).some((key) => !['scale', 'position'].includes(key))) return false
  if (value.scale !== undefined && (typeof value.scale !== 'number' || !Number.isFinite(value.scale) || value.scale < 0.05 || value.scale > 10)) return false
  return value.position === undefined || (Array.isArray(value.position) && value.position.length === 2
    && value.position.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 2))
}
function copyAsset(asset: AssistantAvatarAsset): AssistantAvatarAsset {
  return { renderer: asset.renderer, source: asset.source, spriteVersion: asset.spriteVersion,
    ...(asset.stateSources === undefined ? {} : { stateSources: { ...asset.stateSources } }),
    ...(asset.motionGroups === undefined ? {} : { motionGroups: { ...asset.motionGroups } }),
    ...(asset.live2d === undefined ? {} : { live2d: { ...asset.live2d, ...(asset.live2d.position === undefined ? {} : { position: [...asset.live2d.position] as [number, number] }) } }),
  }
}
function validId(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function boundedSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

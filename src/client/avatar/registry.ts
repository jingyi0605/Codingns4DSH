import type { ComponentType } from 'react'
import type { AssistantAvatarModel, AssistantAvatarState, AssistantAvatarSurface } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import { BuiltinAssistantAvatar } from './builtin.js'
import { ImageAssistantAvatar } from './image.js'
import { SpriteSheetAssistantAvatar } from './spritesheet.js'
import { Live2dAssistantAvatar, createLive2dAssistantAvatarPortrait, createLive2dAssistantAvatarPortraitSource } from './live2d.js'
import { createBuiltinAssistantAvatarPortrait, createImageAssistantAvatarPortrait, createSpriteAssistantAvatarPortrait,
  createBuiltinAssistantAvatarPortraitSource, createImageAssistantAvatarPortraitSource, createSpriteAssistantAvatarPortraitSource } from './portrait-capture.js'
import { AssistantAvatarRegistration } from './registration.js'
import type { AssistantAvatarLoadProgress } from './loading.js'
import type { AssistantAvatarPreview } from './preview-store.js'

export interface AssistantAvatarRendererProps {
  readonly model: AssistantAvatarModel
  readonly state: AssistantAvatarState
  readonly surface: AssistantAvatarSurface
  readonly size: number
  readonly onError: (message: string) => void
  readonly onLoadProgress?: (progress: AssistantAvatarLoadProgress) => void
  /** 统一插槽在 Stage0 开启诊断；正式环境不应采集缓存快照和耗时。 */
  readonly diagnostics?: boolean
  /** 提交成功绘制的透明预览；存储与显示生命周期由统一插槽管理。 */
  readonly onPreview?: (preview: AssistantAvatarPreview) => void
}
export interface AssistantAvatarRenderer {
  readonly id: string
  readonly name?: string
  readonly labelKey?: string
  readonly component: ComponentType<AssistantAvatarRendererProps>
  /** 只有主动报告进度的渲染器才自动显示占位，旧扩展无需修改。 */
  readonly reportsLoading?: true
  readonly initialLoadPhase?: 'engine' | 'resources'
  readonly reportsCache?: true
  /** 支持预览的渲染器声明稳定版本；构图或捕获策略变化时更新版本以失效缓存。 */
  readonly previewVersion?: string
  /** 自动头像由渲染适配器提供；返回静态方形 PNG，旧扩展可不实现。 */
  readonly portraitVersion?: string
  readonly createPortrait?: (model: AssistantAvatarModel, signal: AbortSignal) => Promise<AssistantAvatarPreview | undefined>
  /** 提供可微调的完整静态帧；未实现的扩展仍可裁剪已有头像。 */
  readonly createPortraitSource?: (model: AssistantAvatarModel, signal: AbortSignal) => Promise<AssistantAvatarPreview | undefined>
}

/** 与语音适配器一样按服务实例隔离，页面卸载不会污染另一份 Client。 */
export class AssistantAvatarRegistry extends AssistantAvatarRegistration<AssistantAvatarRenderer> {
  constructor() {
    super([
      { id: 'builtin', component: BuiltinAssistantAvatar, reportsLoading: true, portraitVersion: '1', createPortrait: createBuiltinAssistantAvatarPortrait, createPortraitSource: createBuiltinAssistantAvatarPortraitSource },
      { id: 'image', labelKey: 'avatar.type.image', component: ImageAssistantAvatar, reportsLoading: true, portraitVersion: '1', createPortrait: createImageAssistantAvatarPortrait, createPortraitSource: createImageAssistantAvatarPortraitSource },
      { id: 'spritesheet', labelKey: 'avatar.type.spritesheet', component: SpriteSheetAssistantAvatar, reportsLoading: true, portraitVersion: '1', createPortrait: createSpriteAssistantAvatarPortrait, createPortraitSource: createSpriteAssistantAvatarPortraitSource },
      { id: 'live2d', labelKey: 'avatar.type.live2d', component: Live2dAssistantAvatar,
        reportsLoading: true, initialLoadPhase: 'engine', reportsCache: true, previewVersion: '1', portraitVersion: '1', createPortrait: createLive2dAssistantAvatarPortrait, createPortraitSource: createLive2dAssistantAvatarPortraitSource },
    ])
  }
}

const registries = new WeakMap<CodingNsClientServices, AssistantAvatarRegistry>()
/** 配置草稿借用正式渲染器注册表，保留第三方扩展。 */
export function bindAssistantAvatarRegistry(services: CodingNsClientServices, registry: AssistantAvatarRegistry): void { registries.set(services, registry) }
export function getAssistantAvatarRegistry(services: CodingNsClientServices): AssistantAvatarRegistry {
  let registry = registries.get(services)
  if (registry === undefined) { registry = new AssistantAvatarRegistry(); registries.set(services, registry) }
  return registry
}
/** 扩展模块应将返回的注销函数登记到自己的 context.resources。 */
export function registerAssistantAvatarRenderer(services: CodingNsClientServices, renderer: AssistantAvatarRenderer): () => void {
  return getAssistantAvatarRegistry(services).register(renderer)
}

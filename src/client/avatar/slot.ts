import { Component, createElement, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AssistantAvatarModel, AssistantAvatarState, AssistantAvatarSurface } from '../../shared/assistant-avatar.js'
import { BUILTIN_ASSISTANT_AVATAR, resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import { useCodingNsTranslator } from '../locale.js'
import { dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import { BuiltinAssistantAvatar } from './builtin.js'
import { getAssistantAvatarRegistry } from './registry.js'
import type { AssistantAvatarRenderer } from './registry.js'
import { AssistantAvatarLoading } from './loading.js'
import type { AssistantAvatarLoadProgress } from './loading.js'
import { useAssistantAvatarPreview } from './preview.js'
import { getAssistantAvatarPortraitService } from './portrait-service.js'
import type { AssistantAvatarPreview } from './preview-store.js'
import { assistantAvatarPreviewKey } from './preview-store.js'
import { assistantAvatarRuntimeRevision, subscribeAssistantAvatarRuntime } from '../../shared/assistant-avatar-engine.js'

export interface AssistantAvatarSlotProps {
  readonly services: CodingNsClientServices
  readonly model: AssistantAvatarModel
  readonly state: AssistantAvatarState
  readonly surface: AssistantAvatarSurface
  readonly size: number
  /** 创建预览可隐藏开发诊断，不影响其他插槽的 Stage0 诊断行为。 */
  readonly showDiagnostics?: boolean
  /** 临时预览不写持久预览或头像缓存，失败时也不展示另一个内置角色。 */
  readonly transient?: boolean
}

/** 两个容器只调用这个插槽；渲染错误始终被限制在形象区域。 */
export function AssistantAvatarSlot(props: AssistantAvatarSlotProps): ReactElement {
  const model = resolveAssistantAvatarAsset(props.model, props.surface)
  const registry = getAssistantAvatarRegistry(props.services)
  const readRenderer = useCallback(() => registry.get(model.renderer), [registry, model.renderer])
  const renderer = useSyncExternalStore(registry.subscribe, readRenderer, readRenderer)
  const runtimeRevision = useSyncExternalStore(subscribeAssistantAvatarRuntime, assistantAvatarRuntimeRevision, assistantAvatarRuntimeRevision)
  const generation = useRef({ renderer, value: 0 })
  // 扩展修复后重新注册同一个 ID，也应恢复渲染，不能永久停在旧错误边界里。
  if (generation.current.renderer !== renderer) generation.current = { renderer, value: generation.current.value + 1 }
  // 安装完成重建 Live2D 的错误边界和内容状态，其他渲染器保持现有实例。
  return createElement(AvatarErrorBoundary, { key: `${JSON.stringify(props.model)}:${generation.current.value}:${model.renderer === 'live2d' ? runtimeRevision : 0}`, fallback: createElement(AvatarFallback, props) },
    createElement(AvatarContent, { ...props, model, renderer }))
}

function AvatarContent({ services, model, state, surface, size, renderer, showDiagnostics, transient }: AssistantAvatarSlotProps & { readonly renderer: AssistantAvatarRenderer | undefined }): ReactElement {
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<AssistantAvatarLoadProgress | undefined>(() => renderer?.reportsLoading === true
    ? { phase: renderer.initialLoadPhase ?? 'resources' } : undefined)
  const { preview, onPreview, discard } = useAssistantAvatarPreview(model, surface, transient ? undefined : renderer?.previewVersion)
  const previewKey = assistantAvatarPreviewKey(model, surface, renderer?.previewVersion ?? '')
  const publishPreview = useCallback((snapshot: AssistantAvatarPreview): void => {
    onPreview?.(snapshot)
    if (!transient && renderer !== undefined) getAssistantAvatarPortraitService(services).offerPreview(model, surface, renderer, snapshot)
  }, [services, previewKey, surface, renderer, onPreview, transient])
  const onError = useCallback((message: string) => { discard(true); setError(message) }, [discard])
  const onLoadProgress = useCallback((next: AssistantAvatarLoadProgress) => setProgress(next), [])
  const t = useCodingNsTranslator(services.locale)
  const diagnostics = services.stage0 === true && showDiagnostics !== false
  const props = { model, state, surface, size, onError, onLoadProgress, diagnostics, ...(onPreview === undefined ? {} : { onPreview: publishPreview }) }
  const component = renderer?.component
  const showCache = diagnostics && (renderer?.reportsCache === true || progress?.cacheBefore !== undefined || progress?.cacheAfter !== undefined)
  const content = component === undefined ? null : createElement(component, props)
  if (error !== '' || content === null) return createElement(AvatarFallback, { services, model, state, surface, size,
    ...(transient === undefined ? {} : { transient }), ...(error === '' ? {} : { error }) })
  return createElement('div', { 'data-codingns-avatar-slot': surface, 'data-codingns-avatar-renderer': model.renderer,
    'data-codingns-avatar-state': state, 'aria-label': t('avatar.character', { name: model.name }),
    'aria-busy': progress !== undefined && progress.phase !== 'ready',
    style: { position: 'relative', display: 'grid', justifyItems: 'center', maxWidth: '100%', minWidth: 0 } },
    createElement('div', { style: { opacity: progress !== undefined && progress.phase !== 'ready' ? 0 : 1,
      transition: 'opacity .25s ease', maxWidth: '100%' } }, content),
    preview === undefined ? null : createElement('img', { key: preview.url, src: preview.url, alt: '', 'aria-hidden': true, draggable: false,
      'data-codingns-avatar-preview': true, onError: () => discard(),
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
        opacity: progress !== undefined && progress.phase !== 'ready' ? 1 : 0, transition: 'opacity .25s ease' } }),
    progress === undefined || (progress.phase === 'ready' && (!diagnostics || (progress.elapsedMs === undefined && !showCache))) ? null
      : createElement(AssistantAvatarLoading, { progress, size, t, showCache, diagnostics, preview: preview !== undefined, animationOnly: transient === true }))
}

const loadErrorKeys = { avatar_runtime_unavailable: 'avatar.live2dEngineUnavailable', avatar_runtime_invalid: 'avatar.live2dRuntimeInvalid',
  avatar_webgl_unavailable: 'avatar.live2dWebglUnavailable' } as const

function AvatarFallback(props: AssistantAvatarSlotProps & { readonly error?: string }): ReactElement {
  const t = useCodingNsTranslator(props.services.locale)
  const key = props.error === undefined ? undefined : loadErrorKeys[props.error as keyof typeof loadErrorKeys]
  const detail = props.error === undefined ? null : createElement('small', { 'data-codingns-avatar-load-error': true, style: { display: 'block', marginTop: 8, overflowWrap: 'anywhere' } },
    t('avatar.loadErrorReason', { reason: key === undefined ? props.error : t(key) }))
  if (props.transient) return createElement('div', { role: 'alert', 'data-codingns-avatar-preview-failed': true, style: dshSettingsHelpStyle },
    t(props.model.renderer === 'live2d' ? 'avatar.temporaryLive2dLoadFailed' : 'avatar.temporaryLoadFailed'), detail)
  return createElement('div', { 'data-codingns-avatar-fallback': true, style: { display: 'grid', justifyItems: 'center', maxWidth: '100%' } },
    createElement(BuiltinAssistantAvatar, { ...props, model: BUILTIN_ASSISTANT_AVATAR, onError: () => undefined }),
    createElement('span', { role: 'status', style: { ...dshSettingsHelpStyle, color: dshThemeColor.labelSecondary, textAlign: 'center', maxWidth: props.size } }, t('avatar.loadFailed')), detail)
}
class AvatarErrorBoundary extends Component<{ readonly children?: ReactNode; readonly fallback: ReactElement }, { readonly failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children }
}

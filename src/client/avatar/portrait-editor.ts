import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactElement } from 'react'
import CropperComponent from 'react-easy-crop'
import type { Area, CropperProps } from 'react-easy-crop'
import { resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import { assistantSettingTextStyle } from '../assistant-settings-styles.js'
import { AssistantAvatarPortrait } from './portrait.js'
import { getAssistantAvatarRegistry } from './registry.js'
import type { AssistantAvatarRenderer } from './registry.js'
import { assistantAvatarPortraitKey, getAssistantAvatarPortraitService } from './portrait-service.js'
import type { AssistantAvatarPreview } from './preview-store.js'
import { cropAssistantAvatarPortrait, initialAssistantAvatarPortraitArea } from './portrait-capture.js'

// 上游 ESM 入口默认导出组件，但其 CommonJS 声明被 NodeNext 判为命名空间。
const Cropper = CropperComponent as unknown as ComponentType<Partial<CropperProps> & Pick<CropperProps, 'crop' | 'onCropChange'>>

interface EditorProps {
  readonly services: CodingNsClientServices; readonly model: AssistantAvatarModel
  readonly disabled: boolean; readonly t: CodingNsTranslator
}
/** 与名称同一行的头像设置；资源或渲染器变化时销毁未确认的裁剪会话。 */
export function AssistantAvatarPortraitEditor(props: EditorProps): ReactElement {
  const registry = getAssistantAvatarRegistry(props.services), id = resolveAssistantAvatarAsset(props.model, 'dialog').renderer
  const read = useCallback(() => registry.get(id), [registry, id])
  const renderer = useSyncExternalStore(registry.subscribe, read, read)
  return createElement(PortraitEditorContent, { ...props, renderer, key: assistantAvatarPortraitKey(props.model, renderer) })
}
function PortraitEditorContent({ services, model, renderer, disabled, t }: EditorProps & { readonly renderer: AssistantAvatarRenderer | undefined }): ReactElement {
  const service = getAssistantAvatarPortraitService(services)
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const [source, setSource] = useState<{ preview: AssistantAvatarPreview; url: string; initial?: Area }>()
  const [area, setArea] = useState<Area>(), [crop, setCrop] = useState({ x: 0, y: 0 }), [zoom, setZoom] = useState(1)
  const [percentages, setPercentages] = useState<Area>()
  const session = useRef<{ controller: AbortController; url?: string }>()
  const release = useCallback((): void => {
    session.current?.controller.abort()
    if (session.current?.url !== undefined) URL.revokeObjectURL(session.current.url)
    session.current = undefined
  }, [])
  const close = useCallback((): void => { release(); setOpen(false); setSource(undefined); setArea(undefined); setPercentages(undefined); setPending(false); setError('') }, [release])
  useEffect(() => release, [release])
  useEffect(() => { if (disabled) close() }, [disabled, close])
  const edit = async (): Promise<void> => {
    if (disabled || pending) return
    close(); setOpen(true); setPending(true); setCrop({ x: 0, y: 0 }); setZoom(1)
    const active: NonNullable<typeof session.current> = { controller: new AbortController() }; session.current = active
    try {
      const preview = await service.getSource(model, renderer, active.controller.signal)
      if (preview === undefined) throw new Error('avatar_portrait_source_unavailable')
      const initial = preview.cropAreaPercentages ?? await initialAssistantAvatarPortraitArea(preview, active.controller.signal)
      if (active.controller.signal.aborted || session.current !== active) return
      active.url = URL.createObjectURL(preview.blob)
      setSource({ preview, url: active.url, ...(initial === undefined ? {} : { initial }) })
    } catch { if (!active.controller.signal.aborted) setError(t('avatar.portraitSourceFailed')) }
    finally { if (session.current === active) setPending(false) }
  }
  const save = async (): Promise<void> => {
    const active = session.current
    if (disabled || pending || source === undefined || area === undefined || active === undefined) return
    setPending(true); setError('')
    try {
      const preview = await cropAssistantAvatarPortrait(source.preview, area, active.controller.signal)
      if (preview === undefined) throw new Error('avatar_portrait_crop_failed')
      await service.setPortrait(model, renderer, { ...preview, ...(percentages === undefined ? {} : { cropAreaPercentages: percentages }) }, active.controller.signal)
      if (session.current === active) close()
    } catch { if (!active.controller.signal.aborted) setError(t('avatar.portraitSaveFailed')) }
    finally { if (session.current === active) setPending(false) }
  }
  const changedArea = useCallback((percent: Area, pixels: Area) => { setArea(pixels); setPercentages(percent) }, [])
  const locked = disabled || pending && source !== undefined
  // 让头像字段占右列，说明和编辑面板参与父级网格并使用整行宽度。
  return createElement('div', { 'data-codingns-portrait-settings': model.id, style: { ...assistantSettingTextStyle, display: 'contents' } },
    createElement('div', { 'data-codingns-portrait-controls': true, style: { display: 'grid', gap: 6, minWidth: 0 } },
      createElement('span', null, t('avatar.portraitTitle')),
      createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 } },
        createElement(AssistantAvatarPortrait, { services, model, size: 44 }),
        createElement('button', { type: 'button', disabled: disabled || pending, 'aria-expanded': open, 'data-codingns-portrait-edit': true,
          style: dshSettingsButtonStyle, onClick: () => { void edit() } }, t('avatar.portraitEdit')))),
    createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0, gridColumn: '1 / -1' } }, t(services.configurationDraft ? 'avatar.portraitDraftHint' : 'avatar.portraitLocalHint')),
    !open ? null : createElement('div', { 'data-codingns-portrait-editor': true, 'aria-busy': pending, style: { display: 'grid', gap: 12, padding: 12,
      gridColumn: '1 / -1', border: `1px solid ${dshThemeColor.border}`, borderRadius: 10, minWidth: 0 } },
      source === undefined ? null : createElement('div', { 'data-codingns-portrait-cropper': true, style: { position: 'relative', height: 270, width: '100%', minWidth: 0,
        overflow: 'hidden', borderRadius: 8, background: dshThemeColor.surfaceSubtle, pointerEvents: locked ? 'none' : 'auto' } },
        createElement(Cropper, { image: source.url, crop, zoom, aspect: 1, cropShape: 'round', showGrid: false, minZoom: 1, maxZoom: 8,
          zoomWithScroll: false, onCropChange: (next) => { if (!locked) setCrop(next) }, onZoomChange: (next) => { if (!locked) setZoom(next) }, onCropAreaChange: changedArea,
          ...(source.initial === undefined ? {} : { initialCroppedAreaPercentages: source.initial }),
          cropperProps: { 'aria-label': t('avatar.portraitCropArea'), 'aria-disabled': locked, tabIndex: locked ? -1 : 0 } })),
      source === undefined ? null : createElement('label', { style: { display: 'grid', gap: 6 } }, t('avatar.portraitZoom'),
        createElement('input', { type: 'range', min: 1, max: 8, step: .01, value: zoom, disabled: locked,
          'data-codingns-portrait-zoom': true, onChange: (event: { currentTarget: { value: string } }) => setZoom(Number(event.currentTarget.value)), style: { width: '100%', margin: 0 } })),
      source === undefined || area === undefined ? null : createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        createElement('span', { 'data-codingns-portrait-crop-preview': true, 'aria-hidden': true, style: { position: 'relative', overflow: 'hidden', borderRadius: '50%', width: 56, height: 56, flex: '0 0 56px' } },
          createElement('img', { src: source.url, alt: '', draggable: false, style: { position: 'absolute', maxWidth: 'none',
            width: source.preview.width / area.width * 56, height: source.preview.height / area.height * 56,
            left: -area.x / area.width * 56, top: -area.y / area.height * 56 } })),
        createElement('span', { style: dshSettingsHelpStyle }, t('avatar.portraitDragHint'))),
      !pending ? null : createElement('span', { role: 'status', style: dshSettingsHelpStyle }, t(source === undefined ? 'avatar.portraitLoading' : 'avatar.portraitSaving')),
      error === '' ? null : createElement('span', { role: 'alert', style: { ...dshSettingsHelpStyle, color: dshThemeColor.error } }, error),
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 } },
        createElement('button', { type: 'button', disabled: locked, style: dshSettingsButtonStyle, onClick: close }, t('avatar.portraitCancel')),
        createElement('button', { type: 'button', disabled: disabled || pending || area === undefined, style: dshSettingsPrimaryButtonStyle,
          'data-codingns-portrait-save': true, onClick: () => { void save() } }, t(services.configurationDraft ? 'avatar.portraitConfirm' : 'avatar.portraitSave')))))
}

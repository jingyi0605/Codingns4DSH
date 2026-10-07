import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantAvatarModel, AssistantAvatarSurface } from '../../shared/assistant-avatar.js'
import { assistantAvatarPreviewKey, assistantAvatarPreviewStore, validAssistantAvatarPreview } from './preview-store.js'
import type { AssistantAvatarPreview } from './preview-store.js'

/** 插槽拥有读写与 URL 生命周期；渲染器仅提交图像，不接触持久化存储。 */
export function useAssistantAvatarPreview(model: AssistantAvatarModel, surface: AssistantAvatarSurface, version: string | undefined) {
  const key = version === undefined ? undefined : assistantAvatarPreviewKey(model, surface, version)
  const [preview, setPreview] = useState<{ key: string; url: string; width: number; height: number } | undefined>()
  const session = useRef<{ key: string; controller: AbortController; url: string | undefined; published: boolean } | undefined>(undefined)
  useEffect(() => {
    setPreview(undefined)
    if (key === undefined) return undefined
    const active = { key, controller: new AbortController(), published: false, url: undefined } as NonNullable<typeof session.current>
    session.current = active
    void assistantAvatarPreviewStore.read(key, active.controller.signal).then((snapshot) => {
      if (snapshot === undefined || active.controller.signal.aborted || active.published) return
      active.url = URL.createObjectURL(snapshot.blob)
      setPreview({ key, url: active.url, width: snapshot.width, height: snapshot.height })
    }).catch(() => undefined)
    return () => { active.controller.abort(); if (active.url !== undefined) URL.revokeObjectURL(active.url); if (session.current === active) session.current = undefined }
  }, [key])

  const onPreview = useCallback((snapshot: AssistantAvatarPreview): void => {
    const active = session.current
    if (key === undefined || active?.key !== key || active.controller.signal.aborted || !validAssistantAvatarPreview(snapshot)) return
    active.published = true
    // 不等待落盘才显示动画；新预览可用于同一实例隐藏后再次载入。
    // 已有预览保持同一 DOM 图片直到淡出，避免换 src 解码时在交接帧闪白。
    if (active.url === undefined) {
      try {
        active.url = URL.createObjectURL(snapshot.blob)
        setPreview({ key, url: active.url, width: snapshot.width, height: snapshot.height })
      } catch { /* 临时图片地址不可用不阻断真实形象，也不阻断数据库写入。 */ }
    }
    void assistantAvatarPreviewStore.write(key, model.id, surface, snapshot, active.controller.signal).catch(() => undefined)
  }, [key, model.id, surface])
  const discard = useCallback((stop = false): void => {
    const active = session.current
    if (active === undefined || active.key !== key) return
    active.published = true
    if (stop) active.controller.abort()
    if (active.url !== undefined) URL.revokeObjectURL(active.url)
    active.url = undefined
    setPreview(undefined)
    if (key !== undefined) void assistantAvatarPreviewStore.remove(key).catch(() => undefined)
  }, [key])
  return { preview: preview?.key === key ? preview : undefined, onPreview: version === undefined ? undefined : onPreview, discard }
}

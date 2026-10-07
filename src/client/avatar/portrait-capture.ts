import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { assistantAvatarImageSource, BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarPreview } from './preview-store.js'

export const ASSISTANT_AVATAR_PORTRAIT_SIZE = 128
export interface AssistantAvatarPortraitCrop { readonly x: number; readonly y: number; readonly size: number }
export interface AssistantAvatarPortraitArea { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** 先去掉透明边距，再取上部角色轮廓；不修改原素材，也不识别具体角色 ID。 */
export function assistantAvatarPortraitCrop(pixels: Uint8ClampedArray, width: number, height: number): AssistantAvatarPortraitCrop | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 512 || height > 512 || pixels.length !== width * height * 4) return undefined
  let left = width, right = -1, top = height, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! < 24) continue
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  if (right < left) return undefined
  const upperBottom = Math.min(bottom, top + Math.ceil((bottom - top + 1) * .56))
  let upperLeft = width, upperRight = -1
  for (let y = top; y <= upperBottom; y++) for (let x = left; x <= right; x++) {
    if (pixels[(y * width + x) * 4 + 3]! < 24) continue
    upperLeft = Math.min(upperLeft, x); upperRight = Math.max(upperRight, x)
  }
  const size = Math.max(1, Math.ceil(Math.max(upperRight - upperLeft + 1, upperBottom - top + 1) * 1.08))
  return { x: (upperLeft + upperRight + 1 - size) / 2, y: top - size * .04, size }
}

/** 图片和动作图集只加载一张现有素材；跨域不允许截图时安静回退。 */
export async function createImageAssistantAvatarPortrait(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  return portraitFromImage(assistantAvatarImageSource(model, 'idle'), signal)
}
export async function createBuiltinAssistantAvatarPortrait(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  return portraitFromImage(BUILTIN_ASSISTANT_AVATAR_SOURCES[model.id] ?? BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]!, signal)
}
export async function createSpriteAssistantAvatarPortrait(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  const image = await loadImage(model.source, signal)
  const rows = model.spriteVersion === 2 ? 11 : 9
  if (image === undefined || image.naturalWidth !== 1536 || image.naturalHeight !== 208 * rows) return undefined
  // v1/v2 的待机首帧均为左上 192×208，绝不能缩放整张图集作为头像。
  return cropImage(image, signal, { x: 0, y: 0, width: 192, height: 208 })
}
/** 微调使用完整静态角色或图集首帧，避免在已裁好的小头像上继续损失构图。 */
export async function createImageAssistantAvatarPortraitSource(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  const image = await loadImage(assistantAvatarImageSource(model, 'idle'), signal)
  return image === undefined ? undefined : imageFrame(image, signal)
}
export async function createBuiltinAssistantAvatarPortraitSource(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  return createImageAssistantAvatarPortraitSource({ ...model, source: BUILTIN_ASSISTANT_AVATAR_SOURCES[model.id] ?? BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]! }, signal)
}
export async function createSpriteAssistantAvatarPortraitSource(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  const image = await loadImage(model.source, signal)
  if (image === undefined || image.naturalWidth !== 1536 || image.naturalHeight !== 208 * (model.spriteVersion === 2 ? 11 : 9)) return undefined
  return imageFrame(image, signal, { x: 0, y: 0, width: 192, height: 208 })
}
async function imageFrame(image: HTMLImageElement, signal: AbortSignal,
  frame = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }): Promise<AssistantAvatarPreview | undefined> {
  if (signal.aborted || typeof document === 'undefined') return undefined
  try {
    const scale = Math.min(1, 512 / Math.max(frame.width, frame.height)), canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(frame.width * scale)); canvas.height = Math.max(1, Math.round(frame.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.drawImage(image, frame.x, frame.y, frame.width, frame.height, 0, 0, canvas.width, canvas.height)
    return await encodePortrait(canvas, signal)
  } catch { return undefined }
}
/** 裁剪组件仅负责交互及坐标；像素输出保留透明背景并统一成 128px。 */
export async function cropAssistantAvatarPortrait(source: AssistantAvatarPreview, area: AssistantAvatarPortraitArea,
  signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  if (signal.aborted || ![area.x, area.y, area.width, area.height].every(Number.isFinite)
    || area.width <= 0 || area.height <= 0 || Math.abs(area.width - area.height) > 1
    || area.x < 0 || area.y < 0 || area.x + area.width > source.width + 1 || area.y + area.height > source.height + 1) return undefined
  const url = URL.createObjectURL(source.blob)
  try {
    const image = await loadImage(url, signal)
    if (image === undefined || typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, 128, 128)
    return await encodePortrait(canvas, signal)
  } catch { return undefined }
  finally { URL.revokeObjectURL(url) }
}
/** 初始化裁剪框仍落在角色上部，组件随后负责拖动与缩放。 */
export async function initialAssistantAvatarPortraitArea(source: AssistantAvatarPreview, signal: AbortSignal): Promise<AssistantAvatarPortraitArea | undefined> {
  if (signal.aborted) return undefined
  const url = URL.createObjectURL(source.blob)
  try {
    const image = await loadImage(url, signal)
    if (image === undefined || typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return undefined
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const crop = assistantAvatarPortraitCrop(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    if (crop === undefined) return undefined
    const size = Math.min(crop.size, canvas.width, canvas.height)
    return { x: Math.max(0, Math.min(canvas.width - size, crop.x)) / canvas.width * 100,
      y: Math.max(0, Math.min(canvas.height - size, crop.y)) / canvas.height * 100, width: size / canvas.width * 100, height: size / canvas.height * 100 }
  } catch { return undefined }
  finally { URL.revokeObjectURL(url) }
}
export async function createAssistantAvatarPortraitFromPreview(preview: AssistantAvatarPreview, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  if (signal.aborted) return undefined
  const url = URL.createObjectURL(preview.blob)
  try { return await portraitFromImage(url, signal) }
  finally { URL.revokeObjectURL(url) }
}
async function portraitFromImage(source: string, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  const image = await loadImage(source, signal)
  return image === undefined ? undefined : cropImage(image, signal)
}
function loadImage(source: string, signal: AbortSignal): Promise<HTMLImageElement | undefined> {
  if (signal.aborted || typeof Image === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const image = new Image()
    let finished = false
    const finish = (success = false): void => {
      if (finished) return
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      image.onload = null; image.onerror = null
      if (!success) image.src = ''
      resolve(success ? image : undefined)
    }
    const abort = (): void => finish()
    const timer = setTimeout(abort, 30000)
    signal.addEventListener('abort', abort, { once: true })
    image.crossOrigin = 'anonymous'
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0)
    image.onerror = abort
    image.src = source
  })
}
async function cropImage(image: HTMLImageElement, signal: AbortSignal,
  frame = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }): Promise<AssistantAvatarPreview | undefined> {
  if (signal.aborted || typeof document === 'undefined') return undefined
  try {
    // 轮廓分析最多读取 512×512，避免大图和整张动作图集增加头像生成成本。
    const scale = Math.min(1, 512 / Math.max(frame.width, frame.height))
    const sample = document.createElement('canvas')
    sample.width = Math.max(1, Math.round(frame.width * scale)); sample.height = Math.max(1, Math.round(frame.height * scale))
    const context = sample.getContext('2d', { willReadFrequently: true })
    if (context === null) return undefined
    context.drawImage(image, frame.x, frame.y, frame.width, frame.height, 0, 0, sample.width, sample.height)
    const crop = assistantAvatarPortraitCrop(context.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height)
    if (crop === undefined) return undefined
    const output = document.createElement('canvas')
    output.width = ASSISTANT_AVATAR_PORTRAIT_SIZE; output.height = ASSISTANT_AVATAR_PORTRAIT_SIZE
    const target = output.getContext('2d')
    if (target === null) return undefined
    target.imageSmoothingEnabled = true; target.imageSmoothingQuality = 'high'
    // 用平移缩放保留越界透明边距，避免 drawImage 对负裁剪坐标缩短头像。
    const zoom = output.width / crop.size
    target.setTransform(zoom, 0, 0, zoom, -crop.x * zoom, -crop.y * zoom)
    target.drawImage(sample, 0, 0)
    return await encodePortrait(output, signal)
  } catch { return undefined }
}
function encodePortrait(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (blob?: Blob | null): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      resolve(!signal.aborted && blob !== undefined && blob !== null && blob.size > 0 && blob.size <= 512 * 1024
        ? { blob, width: canvas.width, height: canvas.height } : undefined)
    }
    const abort = (): void => finish()
    const timer = setTimeout(abort, 1000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { finish(); return }
    canvas.toBlob((blob) => finish(blob), 'image/png')
  })
}

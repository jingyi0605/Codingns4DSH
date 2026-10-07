import { AVATAR_PREVIEW_MAX_EDGE, validAssistantAvatarPreview } from './preview-store.js'
import type { AssistantAvatarPreview } from './preview-store.js'

/** 在同步绘制窗口拷贝到 2D 画布；PNG 编码异步执行，不保留原 GPU 缓冲。 */
function copyCanvasFrame(source: HTMLCanvasElement): HTMLCanvasElement | undefined {
  if (source.width <= 0 || source.height <= 0) return undefined
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, AVATAR_PREVIEW_MAX_EDGE / Math.max(source.width, source.height))
  canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return undefined
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  // 全透明不代表已渲染，不能写入缓存并在刷新后显示空白。
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 0) return canvas
  return undefined
}

/** 只临时观察当前上下文的绘制，在同一帧微任务中捕获完整图像，完成/取消后还原。 */
export function captureAssistantAvatarPreview(source: HTMLCanvasElement, signal?: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    let queued = false
    const restore: (() => void)[] = []
    const finish = (preview?: AssistantAvatarPreview): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      for (const release of restore.splice(0).reverse()) release()
      resolve(preview)
    }
    const abort = (): void => finish()
    const timer = setTimeout(abort, 1000)
    signal?.addEventListener('abort', abort, { once: true })
    const capture = (): boolean => {
      if (settled || signal?.aborted) return true
      try {
        const canvas = copyCanvasFrame(source)
        if (canvas === undefined) return false
        // 图片已拷贝，不再挂住引擎绘制函数，编码期间也不干扰后续动画。
        for (const release of restore.splice(0).reverse()) release()
        canvas.toBlob((blob) => {
          const preview = blob === null ? undefined : { blob, width: canvas.width, height: canvas.height }
          finish(validAssistantAvatarPreview(preview) ? preview : undefined)
        }, 'image/png')
        return true
      } catch { finish(); return true } // 跨域或不可读取的模型继续显示，只跳过预览。
    }
    try {
      const context = source.getContext('webgl2') ?? source.getContext('webgl')
      if (context === null) { if (!capture()) finish(); return }
      for (const name of ['drawElements', 'drawArrays'] as const) {
        const original = context[name]
        const descriptor = Object.getOwnPropertyDescriptor(context, name)
        const observe = (...args: number[]): void => {
          Reflect.apply(original, context, args)
          if (!queued && !settled) {
            queued = true
            queueMicrotask(() => { queued = false; capture() })
          }
        }
        Object.defineProperty(context, name, { configurable: true, writable: true, value: observe })
        restore.push(() => {
          if (context[name] !== observe) return
          try {
            if (descriptor === undefined) delete (context as unknown as Record<string, unknown>)[name]
            else Object.defineProperty(context, name, descriptor)
          } catch { /* 外部冻结上下文时仍结束等待，不将预览清理失败传播给模型。 */ }
        })
      }
      capture()
    } catch { finish() }
  })
}

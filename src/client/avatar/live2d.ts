import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ASSISTANT_AVATAR_RUNTIME_PATH } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarAsset, AssistantAvatarState } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarRendererProps } from './registry.js'
import type { AssistantAvatarLoadProgress } from './loading.js'
import { readAssistantAvatarCacheStatus } from './cache-status.js'
import { captureAssistantAvatarPreview } from './preview-capture.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { createAssistantAvatarPortraitFromPreview } from './portrait-capture.js'
import type { AssistantAvatarPreview } from './preview-store.js'

/** 仅声明适配器消费的事件契约，编译和默认安装均不依赖外部引擎代码。 */
export interface AssistantLive2dEventMap {
  loadstart: (total: number) => void
  loadprogress: (loaded: number, total: number, path: string) => void
  loaded: () => void
}
export interface AssistantLive2dRuntime {
  load(options: { path: string; scale: number; position?: [number, number]; volume: number; logLevel: 'warn' }): Promise<void>
  getMotions(): Record<string, string[]>
  playMotion(group: string, index?: number, priority?: number): void
  resize(): void
  destroy(): void
  getCanvas?(): HTMLCanvasElement
  on?<K extends keyof AssistantLive2dEventMap>(event: K, listener: AssistantLive2dEventMap[K]): unknown
}
interface AssistantLive2dModule { init(canvas: HTMLCanvasElement): AssistantLive2dRuntime | null }

/** 成功共享引擎；失败更换模块 URL，避免浏览器缓存失败的动态导入而无法恢复。 */
export class AssistantLive2dModuleLoader {
  private module: Promise<AssistantLive2dModule> | undefined
  private attempt = 0
  constructor(private readonly importModule: (url: string) => Promise<AssistantLive2dModule> = (url) => import(/* @vite-ignore */ url),
    private readonly fetchStatus: typeof fetch = (...args) => fetch(...args)) {}
  load(location: string): Promise<AssistantLive2dModule> {
    if (this.module !== undefined) return this.module
    const url = new URL(ASSISTANT_AVATAR_RUNTIME_PATH, location)
    url.searchParams.set('v', '2.1.1')
    if (this.attempt > 0) url.searchParams.set('retry', String(this.attempt))
    this.module = withLoadDeadline(this.importModule(url.href), 45000).then((module) => {
      if (typeof module.init !== 'function') throw new Error('avatar_runtime_invalid')
      return module
    }).catch(async (error: unknown) => {
      this.module = undefined; this.attempt++
      // 动态 import 的错误不包含 HTTP 状态；只在失败时读取状态，不增加成功加载请求。
      let status: number | undefined
      try { status = (await this.fetchStatus(url, { credentials: 'same-origin', signal: AbortSignal.timeout(5000) })).status }
      catch { /* 状态探测失败时保留最初的引擎错误。 */ }
      if (status === 503) throw new Error('avatar_runtime_unavailable')
      if (status !== undefined && status !== 200) throw new Error(`avatar_runtime_http_${status}`)
      throw error
    })
    return this.module
  }
}
const runtimeModuleLoader = new AssistantLive2dModuleLoader()

/** 固定同源独立 ESM，只在用户选择 Live2D 时加载；不进入主 Client bundle。 */
function loadLive2dModule(): Promise<AssistantLive2dModule> {
  return runtimeModuleLoader.load(window.location.href)
}

/** l2d 某些下载失败只记录日志而不拒绝 Promise，必须限制永久等待。 */
async function withLoadDeadline<T>(task: Promise<T>, timeoutMs: number,
  observeActivity?: (refresh: (() => void) | undefined) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      const refresh = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => reject(new Error('avatar_load_timeout')), timeoutMs)
      }
      observeActivity?.(refresh)
      refresh()
    })])
  } finally { clearTimeout(timer); observeActivity?.(undefined) }
}

/** 参考上游 load/setState/resize/destroy；旧加载完成不能复活已销毁实例。 */
export class AssistantLive2dController {
  private disposed = false
  private state: AssistantAvatarState = 'idle'
  private loaded = false
  private loadConfirmed = false
  private cancelLoad: (() => void) | undefined
  private refreshDeadline: (() => void) | undefined
  private report: ((progress: AssistantAvatarLoadProgress) => void) | undefined
  constructor(private readonly runtime: AssistantLive2dRuntime, private readonly motionGroups?: AssistantAvatarAsset['motionGroups'],
    private readonly options?: AssistantAvatarAsset['live2d'], report?: (progress: AssistantAvatarLoadProgress) => void,
    private readonly timeoutMs = 45000) {
    this.report = report
    runtime.on?.('loadstart', (total) => {
      if (this.disposed) return
      this.refreshDeadline?.()
      this.report?.({ phase: 'resources', loaded: 0, total })
    })
    runtime.on?.('loadprogress', (loaded, total) => {
      if (this.disposed) return
      this.refreshDeadline?.()
      this.report?.({ phase: total > 0 && loaded >= total ? 'rendering' : 'resources', loaded, total })
    })
    runtime.on?.('loaded', () => { if (!this.disposed) this.loadConfirmed = true })
  }
  async load(source: string): Promise<boolean> {
    if (this.disposed) return false
    this.loadConfirmed = false
    try {
      const operation = this.runtime.load({ path: source, scale: this.options?.scale ?? 1, volume: 0, logLevel: 'warn',
        ...(this.options?.position === undefined ? {} : { position: [...this.options.position] as [number, number] }) })
        .then(() => {
          if (this.disposed) { this.runtime.destroy(); return false }
          // 真实引擎可能静默返回；只有 loaded 事件才证明初始化成功。
          if (this.runtime.on !== undefined && !this.loadConfirmed) throw new Error('avatar_model_not_loaded')
          return true
        }, (error: unknown) => { if (this.disposed) { this.runtime.destroy(); return false } throw error })
      const cancelled = new Promise<false>((resolve) => { this.cancelLoad = () => resolve(false) })
      // 大模型持续有文件进度时继续等待，只对长时间没有进展的加载超时。
      if (!await withLoadDeadline(Promise.race([operation, cancelled]), this.timeoutMs, (refresh) => { this.refreshDeadline = refresh })) return false
      this.loaded = true
      this.setState(this.state)
      return true
    } catch (error) { this.dispose(); throw error }
    finally { this.cancelLoad = undefined }
  }
  setState(state: AssistantAvatarState): void {
    if (this.disposed) return
    this.state = state
    if (!this.loaded) return
    const groups = Object.keys(this.runtime.getMotions())
    const desired = state === 'speaking' ? /talk|speak/iu : state === 'thinking' ? /think|work/iu
      : state === 'error' ? /fail|error|sad/iu : state === 'listening' || state === 'waiting' ? /listen|wait/iu : /idle/iu
    const configured = this.motionGroups?.[state]
    const group = configured !== undefined && groups.includes(configured) ? configured
      : groups.find((name) => desired.test(name)) ?? groups.find((name) => /idle/iu.test(name))
    if (group !== undefined) this.runtime.playMotion(group, undefined, 2)
  }
  resize(): void { if (!this.disposed && this.loaded) this.runtime.resize() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 上游只有 on，没有 off；清空回调引用并隔离迟到事件，避免持有旧 React 插槽。
    this.report = undefined
    this.cancelLoad?.()
    this.runtime.destroy()
  }
}

/** 没有已绘制预览时只生成一次头像；捕获后立即销毁临时 WebGL 实例。 */
export async function createLive2dAssistantAvatarPortrait(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  const preview = await createLive2dAssistantAvatarPortraitSource(model, signal)
  return preview === undefined ? undefined : createAssistantAvatarPortraitFromPreview(preview, signal)
}
/** 编辑器复用同一静态帧来源，临时实例的销毁仍由适配器统一完成。 */
export async function createLive2dAssistantAvatarPortraitSource(model: AssistantAvatarModel, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
  if (signal.aborted || typeof document === 'undefined') return undefined
  const module = await loadLive2dModule()
  if (signal.aborted) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 555
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:256px;height:277.5px;pointer-events:none;opacity:0'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  let controller: AssistantLive2dController | undefined
  const abort = (): void => controller?.dispose()
  try {
    const runtime = module.init(canvas)
    if (runtime === null) return undefined
    controller = new AssistantLive2dController(runtime, model.motionGroups, model.live2d)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted || !await controller.load(model.source) || signal.aborted) return undefined
    return await captureAssistantAvatarPreview(runtime.getCanvas?.() ?? canvas, signal)
  } finally { signal.removeEventListener('abort', abort); controller?.dispose(); canvas.remove() }
}

export function Live2dAssistantAvatar({ model, state, size, onError, onLoadProgress, diagnostics = false, onPreview }: AssistantAvatarRendererProps): ReactElement {
  const configKey = JSON.stringify([model.motionGroups, model.live2d])
  // 设置归一化会复制 JSON；等值映射不能因为父组件刷新而重载整个 WebGL 模型。
  const config = useMemo(() => ({ motionGroups: model.motionGroups, options: model.live2d }), [configKey])
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const controller = useRef<AssistantLive2dController | undefined>(undefined)
  const currentState = useRef(state)
  currentState.current = state
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const refresh = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [])
  useEffect(() => {
    const target = canvas.current
    if (target === null || !visible) return undefined
    let disposed = false
    let instance: AssistantLive2dController | undefined
    const previewController = new AbortController()
    const started = diagnostics ? performance.now() : 0
    let progress: AssistantAvatarLoadProgress = { phase: 'engine' }
    const report = (next: AssistantAvatarLoadProgress): void => {
      if (disposed) return
      if (!diagnostics) { onLoadProgress?.(next); return }
      const elapsedMs = performance.now() - started
      progress = { ...progress, ...next, elapsedMs,
        ...(next.phase === 'rendering' && progress.resourcesMs === undefined ? { resourcesMs: elapsedMs } : {}) }
      onLoadProgress?.(progress)
    }
    report(progress)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => instance?.resize())
    observer?.observe(target)
    // 正式环境不启动缓存诊断，也不等待它；Stage0 才采集真实前后快照。
    void Promise.all([loadLive2dModule(), diagnostics ? readAssistantAvatarCacheStatus(model.source, window.location.href) : undefined]).then(async ([module, before]) => {
      if (disposed) return
      report({ phase: 'resources', ...(before === undefined ? {} : { cacheBefore: before }) })
      const runtime = module.init(target)
      if (runtime === null) throw new Error('avatar_webgl_unavailable')
      instance = new AssistantLive2dController(runtime, config.motionGroups, config.options, report)
      controller.current = instance
      instance.setState(currentState.current)
      if (!await instance.load(model.source) || disposed) return
      if (onPreview !== undefined) {
        // 引擎 loaded 时首帧可能还未绘制；等待有效绘制后才替换本地静态预览。
        const preview = await captureAssistantAvatarPreview(runtime.getCanvas?.() ?? target, previewController.signal)
        if (disposed) return
        if (preview !== undefined) onPreview(preview)
      }
      report({ phase: 'ready' })
      if (!diagnostics) return
      // 加载已完成，诊断不推迟角色显示；保留真实完成耗时，排除诊断响应时间。
      const finished = progress
      const after = await readAssistantAvatarCacheStatus(model.source, window.location.href)
      if (!disposed && after !== undefined) {
        progress = { ...finished, cacheAfter: after }
        onLoadProgress?.(progress)
      }
    }).catch((error: unknown) => { if (!disposed) onError(error instanceof Error ? error.message : String(error)) })
    return () => { disposed = true; previewController.abort(); observer?.disconnect(); instance?.dispose(); controller.current = undefined }
  }, [model.source, config, visible, onError, onLoadProgress, diagnostics, onPreview])
  useEffect(() => { controller.current?.setState(state) }, [state])
  return createElement('canvas', { ref: canvas, width: Math.round(size * 2), height: Math.round(size * 208 / 192 * 2), 'aria-hidden': true,
    style: { width: size, height: 'auto', aspectRatio: '192 / 208', maxWidth: '100%', display: 'block' } })
}

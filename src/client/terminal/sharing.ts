import type { TerminalSharingBridge } from '../../dsh-capabilities/client/terminal-sharing-adapter.js'
import type { TerminalTextSnapshot, TerminalShareTarget } from '../../shared/contracts/terminal-share.js'
import { captureTerminalSnapshot, decodeTerminalSnapshot, encodeTerminalSnapshot, formatTerminalSnapshot, TERMINAL_LOG_REFERENCE_SOURCE, type TerminalTextReader } from './snapshot.js'
import type { CodingNsTerminalView } from './model.js'
import { debugWarn } from '../../shared/debug.js'
import { resolveCodingNsTranslator, type CodingNsTranslator } from '../locale.js'

export type TerminalLogPreviewState = { readonly snapshot: TerminalTextSnapshot } | { readonly error: string }

/** 终端视图只登记读取器，不把 xterm 实例泄漏给会话输入框。 */
export class TerminalSharing {
  private readonly readers = new Map<CodingNsTerminalView, TerminalTextReader>()
  private bridge: TerminalSharingBridge | undefined
  private referenceReady = false
  private disposeReference: (() => void) | undefined
  private newTargets = new WeakMap<TerminalTextSnapshot, Promise<string>>()
  private preview: TerminalLogPreviewState | undefined
  private readonly previewListeners = new Set<() => void>()

  constructor(private readonly t: CodingNsTranslator = resolveCodingNsTranslator()) {}

  /** 快照与订阅函数均保持稳定，悬浮预览不依赖右栏终端是否挂载。 */
  readonly getPreviewSnapshot = (): TerminalLogPreviewState | undefined => this.preview
  readonly subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.add(listener)
    return () => { this.previewListeners.delete(listener) }
  }
  readonly closePreview = (): void => { this.setPreview(undefined) }

  attachBridge(bridge: TerminalSharingBridge): () => void {
    this.newTargets = new WeakMap()
    this.bridge = bridge
    return () => {
      if (this.bridge !== bridge) return
      this.releaseReferences()
      this.newTargets = new WeakMap()
      this.bridge = undefined
    }
  }

  /** 引用源单独跟随 inputTriggers 生命周期，服务消失时暂停卡片分享。 */
  attachReferences(): () => void {
    this.releaseReferences()
    let dispose: (() => void) | undefined
    try {
      const t = this.t
      dispose = this.requireBridge().registerReferences(TERMINAL_LOG_REFERENCE_SOURCE, {
        clipboardText: (ref) => formatTerminalSnapshot(decodeTerminalSnapshot(ref), t),
        async serialize(ref, signal) {
          signal.throwIfAborted()
          return formatTerminalSnapshot(decodeTerminalSnapshot(ref), t)
        },
      }, (ref) => {
        // 服务停用后拒绝旧回调，损坏引用只影响预览，不让点击异常进入编辑器。
        if (dispose === undefined || this.disposeReference !== dispose) return false
        try { this.setPreview({ snapshot: decodeTerminalSnapshot(ref) }) }
        catch { this.setPreview({ error: t('terminalShare.preview.invalid') }) }
        return true
      })
    } catch (cause) {
      debugWarn('codingns4dsh: 终端引用源注册失败，暂停日志卡片分享', { error: cause instanceof Error ? cause.message : String(cause) })
    }
    this.disposeReference = dispose
    this.referenceReady = dispose !== undefined
    return () => { if (dispose !== undefined && this.disposeReference === dispose) this.releaseReferences() }
  }

  bind(view: CodingNsTerminalView, reader: TerminalTextReader): () => void {
    this.readers.set(view, reader)
    return () => { if (this.readers.get(view) === reader) this.readers.delete(view) }
  }

  capture(view: CodingNsTerminalView, selection?: string): TerminalTextSnapshot {
    const reader = this.readers.get(view)
    const state = view.state.getSnapshot()
    if (reader === undefined || state.info === undefined) throw new Error('终端画面尚未就绪，请稍后重试')
    const source = this.bridge?.source(view.sessionId)
    return captureTerminalSnapshot(reader, {
      terminalId: view.id, title: state.info.title, shell: state.info.shell.name, cwd: state.info.cwd,
      sourceHostId: source?.hostId ?? 'local',
      sourceWorkspaceId: source?.workspaceId || state.environment?.workspaceId || view.sessionId,
    }, selection)
  }

  canReference(): boolean { return this.referenceReady }
  isReady(): boolean { return this.bridge !== undefined }
  async targets(sessionId: string, limit = 5, signal?: AbortSignal): Promise<readonly TerminalShareTarget[]> {
    return this.requireBridge().targets(signal, { sessionId, limit })
  }

  async share(snapshot: TerminalTextSnapshot, target: string, label: string): Promise<void> {
    const bridge = this.requireBridge()
    if (!this.referenceReady) throw new Error(this.t('terminalShare.referenceUnavailable'))
    const text = formatTerminalSnapshot(snapshot, this.t)
    const reference = {
      source: TERMINAL_LOG_REFERENCE_SOURCE, ref: encodeTerminalSnapshot(snapshot), label,
      appearance: 'file' as const, clipboardText: text,
    }
    await bridge.insert(target, text, reference)
  }

  /** 同一快照插入失败后重试，复用已创建的会话，不留下多份空白会话。 */
  async shareToNew(snapshot: TerminalTextSnapshot, sourceSessionId: string, label: string): Promise<void> {
    const bridge = this.requireBridge()
    if (!this.referenceReady) throw new Error(this.t('terminalShare.referenceUnavailable'))
    let target = this.newTargets.get(snapshot)
    if (target === undefined) {
      const created = bridge.createTarget(sourceSessionId).catch((cause: unknown) => {
        if (this.newTargets.get(snapshot) === created) this.newTargets.delete(snapshot)
        throw cause
      })
      this.newTargets.set(snapshot, created)
      target = created
    }
    await this.share(snapshot, await target, label)
  }

  dispose(): void {
    this.releaseReferences()
    this.bridge = undefined
    this.newTargets = new WeakMap()
    this.readers.clear()
    this.previewListeners.clear()
  }

  private setPreview(value: TerminalLogPreviewState | undefined): void {
    if (this.preview === value) return
    this.preview = value
    for (const listener of [...this.previewListeners]) listener()
  }

  private releaseReferences(): void {
    this.closePreview()
    this.disposeReference?.()
    this.disposeReference = undefined
    this.referenceReady = false
  }

  private requireBridge(): TerminalSharingBridge {
    if (this.bridge === undefined) throw new Error('会话分享服务尚未就绪，请稍后重试')
    return this.bridge
  }
}

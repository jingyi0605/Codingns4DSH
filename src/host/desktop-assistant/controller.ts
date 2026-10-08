import type { DesktopAssistantFrame, DesktopAssistantPresentation, DesktopAssistantStatus } from '../../shared/desktop-assistant.js'
import type { DesktopAssistantPage } from './server.js'

export interface DesktopAssistantAgent {
  send(command: Readonly<Record<string, unknown>>): void
  stop(): Promise<void>
}
export interface DesktopAssistantControllerOptions {
  readonly supported: boolean
  readonly readFrame: (presentation: DesktopAssistantPresentation) => DesktopAssistantFrame | undefined
  readonly openPage: (frame: () => DesktopAssistantFrame | undefined) => Promise<DesktopAssistantPage>
  readonly launch: (onEvent: (event: Record<string, unknown>) => void, onExit: () => void) => Promise<DesktopAssistantAgent>
  readonly deadlineMs?: number
}

/** 只有这个控制器拥有进程与端口；Client 的迟到请求不能复活已关闭的 generation。 */
export class DesktopAssistantController {
  private owner: string | undefined
  private sequence = -1
  private generation = 0
  private frame: DesktopAssistantFrame | undefined
  private presentation: DesktopAssistantPresentation = { visible: false, state: 'idle', caption: '', label: '' }
  private page: DesktopAssistantPage | undefined
  private agent: DesktopAssistantAgent | undefined
  private starting: Promise<void> | undefined
  private stopping: Promise<void> = Promise.resolve()
  private visible = false
  private ready = false
  private error: string | undefined
  private openSequence = 0
  private disposed = false
  private settle: ((error?: string) => void) | undefined

  constructor(private readonly options: DesktopAssistantControllerOptions) {}

  attach(owner: string): DesktopAssistantStatus {
    if (this.disposed) return this.status(owner)
    // 页面刷新显式取得所有权，旧页面随后发来的 detach/update 均失效。
    if (this.owner !== owner) { this.owner = owner; this.sequence = -1; this.error = undefined }
    return this.status(owner)
  }

  async update(owner: string, sequence: number, presentation: DesktopAssistantPresentation): Promise<DesktopAssistantStatus> {
    if (this.disposed || this.owner !== owner || sequence <= this.sequence) return this.status(owner)
    this.sequence = sequence
    this.presentation = presentation
    await this.refresh()
    return this.status(owner)
  }

  async refresh(): Promise<void> {
    this.frame = this.options.readFrame(this.presentation)
    if (!this.options.supported || this.disposed || !this.owner || !this.frame) { this.error = undefined; await this.stop(); return }
    if (this.error) return
    if (!this.frame.visible) {
      if (!this.ready) { await this.stop(); return }
      this.visible = false; this.agent?.send({ cmd: 'hide' }); return
    }
    if (!this.agent) {
      this.starting ??= this.start().finally(() => { this.starting = undefined })
      await this.starting
    }
    if (this.ready && this.frame?.visible) this.agent?.send({ cmd: 'show', width: this.frame.size, height: Math.ceil(this.frame.size * 208 / 192) + (this.frame.caption ? 132 : 0) })
  }

  status(owner: string): DesktopAssistantStatus {
    // 能否使用原生形象与窗口是否已经显示是两回事，启动握手期间不能误判为不可用。
    // 当前形象不支持原生渲染时明确放行页面回退，避免一直停留在原生等待状态。
    return { available: this.options.supported && !this.disposed && this.options.readFrame(this.presentation) !== undefined,
      owned: this.owner === owner, attached: this.owner !== undefined,
      visible: this.visible && this.owner === owner, openSequence: this.openSequence, error: this.error }
  }

  async detach(owner: string): Promise<void> {
    if (this.owner !== owner) return
    this.owner = undefined
    await this.stop()
  }

  async dispose(): Promise<void> { this.disposed = true; this.owner = undefined; await this.stop(); await this.starting }

  private async start(): Promise<void> {
    const generation = ++this.generation
    await this.stopping
    if (generation !== this.generation || this.disposed) return
    let page: DesktopAssistantPage | undefined
    let agent: DesktopAssistantAgent | undefined
    try {
      page = await this.options.openPage(() => this.frame)
      if (generation !== this.generation) { await page.close(); return }
      this.page = page
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.settle?.('原生悬浮窗口启动超时'), this.options.deadlineMs ?? 20000)
        this.settle = (error) => { clearTimeout(timer); this.settle = undefined; error ? reject(new Error(error)) : resolve() }
      })
      // 防止 launch 期间失败的就绪 Promise 成为未处理拒绝。
      void ready.catch(() => undefined)
      agent = await this.options.launch((event) => this.event(generation, event), () => this.failed(generation, '原生悬浮进程已退出'))
      if (generation !== this.generation) { await agent.stop(); return }
      this.agent = agent
      agent.send({ cmd: 'load', url: page.url, width: this.frame!.size, height: Math.ceil(this.frame!.size * 208 / 192) + (this.frame!.caption ? 132 : 0) })
      await ready
      if (generation !== this.generation) return
      this.ready = true
    } catch (error) {
      this.failed(generation, error instanceof Error ? error.message : String(error))
    }
  }

  private event(generation: number, event: Record<string, unknown>): void {
    if (generation !== this.generation || this.disposed) return
    if (event.ev === 'loaded') this.settle?.()
    if (event.ev === 'shown') this.visible = this.frame?.visible === true
    // 打开 Desktop 或助理工作台只发送交互事件，不改变原生形象的常驻状态。
    if (event.ev === 'open') this.openSequence++
    if (event.ev === 'error') this.failed(generation, typeof event.message === 'string' ? event.message.slice(0, 500) : '原生悬浮窗口不可用')
  }

  private failed(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.error = message
    void this.stop()
  }

  private stop(): Promise<void> {
    this.generation++
    this.visible = false; this.ready = false
    this.settle?.('悬浮窗口已关闭')
    const agent = this.agent, page = this.page
    this.agent = undefined; this.page = undefined
    this.stopping = this.stopping.then(async () => {
      // 任意一项清理失败都不能挡住另一项，也不能让后续 generation 永久挂在拒绝链上。
      await Promise.allSettled([agent?.stop(), page?.close()])
    })
    return this.stopping
  }
}

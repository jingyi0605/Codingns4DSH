import { desktopAssistantNotificationHeight, desktopAssistantLayout, desktopAssistantNotice, readDesktopAssistantLayout, type DesktopAssistantFrame, type DesktopAssistantLayout, type DesktopAssistantNoticeEvent, type DesktopAssistantNoticeFeedback, type DesktopAssistantPresentation, type DesktopAssistantStatus } from '../../shared/desktop-assistant.js'
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
  readonly onNoticePresented?: (event: DesktopAssistantNoticeEvent) => void
  readonly onNoticePage?: (cursor?: string) => void
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
  private noticeSequence = 0
  private noticeFrameSequence = 0
  private noticeFrameKey = ''
  private noticeEvents: DesktopAssistantNoticeEvent[] = []
  private noticeError: string | undefined
  private noticeFeedbackError: { readonly event: DesktopAssistantNoticeEvent; readonly message: string } | undefined
  private presentedNotice = ''
  private notificationExpanded = false
  private layout: DesktopAssistantLayout | undefined
  private disposed = false
  private settle: ((error?: string) => void) | undefined

  constructor(private readonly options: DesktopAssistantControllerOptions) {}

  attach(owner: string): DesktopAssistantStatus {
    if (this.disposed) return this.status(owner)
    // 页面刷新显式取得所有权，旧页面随后发来的 detach/update 均失效。
    if (this.owner !== owner) {
      this.owner = owner; this.sequence = -1; this.error = undefined
      this.noticeEvents = []; this.noticeError = undefined; this.noticeFeedbackError = undefined; this.noticeFrameSequence = 0; this.noticeFrameKey = ''; this.presentedNotice = ''
      this.notificationExpanded = false
    }
    return this.status(owner)
  }

  async update(owner: string, sequence: number, presentation: DesktopAssistantPresentation,
    ack?: { readonly generation: number; readonly sequence: number }, feedback?: DesktopAssistantNoticeFeedback): Promise<DesktopAssistantStatus> {
    if (this.disposed || this.owner !== owner || sequence <= this.sequence) return this.status(owner)
    this.sequence = sequence
    // 先核对还在队列中的动作，再移除已消费事件；旧所有者/旧代次不能给新通知注入反馈。
    const event = feedback === undefined || feedback.generation !== this.generation ? undefined : this.noticeEvents.find((item) =>
      item.sequence === feedback.sequence && item.noticeId === feedback.noticeId && item.noticeGeneration === feedback.noticeGeneration)
    if (event && feedback) this.noticeFeedbackError = { event, message: feedback.message }
    if (ack && ack.generation === this.generation && Number.isSafeInteger(ack.sequence) && ack.sequence >= 0 && ack.sequence <= this.noticeSequence) {
      this.noticeEvents = this.noticeEvents.filter((event) => event.sequence > ack.sequence)
      this.noticeError = undefined
    }
    this.presentation = presentation
    await this.refresh()
    return this.status(owner)
  }

  async refresh(): Promise<void> {
    this.refreshFrame()
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
    if (this.ready && this.frame?.visible) this.agent?.send(this.showCommand('show'))
  }

  status(owner: string): DesktopAssistantStatus {
    // 能否使用原生形象与窗口是否已经显示是两回事，启动握手期间不能误判为不可用。
    // 当前形象不支持原生渲染时明确放行页面回退，避免一直停留在原生等待状态。
    return { available: this.options.supported && !this.disposed && this.options.readFrame(this.presentation) !== undefined,
      owned: this.owner === owner, attached: this.owner !== undefined,
      visible: this.visible && this.owner === owner, openSequence: this.openSequence, error: this.error,
      generation: this.generation, ...(this.owner !== owner ? {} : { noticeEvents: [...this.noticeEvents], ...(this.noticeError === undefined ? {} : { noticeError: this.noticeError }) }) }
  }

  async detach(owner: string): Promise<void> {
    if (this.owner !== owner) return
    this.owner = undefined
    this.noticeEvents = []
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
      this.refreshFrame()
      agent.send({ ...this.showCommand('load'), url: page.url })
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
    if (event.ev === 'shown') { this.visible = this.frame?.visible === true; this.refreshFrame() }
    if (event.ev === 'layout') {
      const next = readDesktopAssistantLayout(event.layout)
      if (next) { this.layout = next; this.refreshFrame() }
    }
    // 打开 Desktop 或助理工作台只发送交互事件，不改变原生形象的常驻状态。
    if (event.ev === 'open') this.openSequence++
    if (event.ev === 'notice-presented' || event.ev === 'notice-action') this.noticeEvent(event)
    if (event.ev === 'notice-page') this.noticePage(event)
    if (event.ev === 'notice-expansion') {
      const identity = this.frame?.identity
      if (identity && this.frame?.notificationSnapshot && event.ownerId === this.owner && event.generation === identity.generation
        && event.sequence === identity.sequence && typeof event.expanded === 'boolean' && event.expanded !== this.notificationExpanded) {
        this.notificationExpanded = event.expanded
        void this.refresh().catch(() => undefined)
      }
    }
    if (event.ev === 'error') this.failed(generation, typeof event.message === 'string' ? event.message.slice(0, 500) : '原生悬浮窗口不可用')
  }

  private refreshFrame(): void {
    const frame = this.options.readFrame(this.presentation)
    // 同一 noticeId 的完成提醒可以升级为错误；呈现版本必须取最终 Host 快照，不能只取主页面请求序号。
    const snapshot = frame?.notificationSnapshot
    const primary = desktopAssistantNotice(frame)
    const key = JSON.stringify([this.owner, this.generation, frame?.notification, snapshot === undefined ? undefined
      : [snapshot.generation, snapshot.primary, snapshot.items, snapshot.cursor, snapshot.unreadCount, snapshot.pendingCount, snapshot.capabilities]])
    if (key !== this.noticeFrameKey) {
      this.noticeFrameKey = key; this.noticeFrameSequence++
      // 未送达主页面的旧首展确认不能确认已经升级的新提醒；用户动作仍保留原有顺序。
      this.noticeEvents = this.noticeEvents.filter((event) => event.type !== 'notice-presented'
        || (event.noticeId === primary?.noticeId && event.noticeGeneration === primary.generation && event.noticeKind === primary.kind))
    }
    this.frame = frame === undefined ? undefined : { ...frame, nativeVisible: this.visible,
      ...(this.matchesNoticeFeedback(frame) ? { noticeError: this.noticeFeedbackError!.message } : {}),
      ...(this.layout === undefined ? {} : { layout: this.layout }),
      ...(this.owner === undefined ? {} : { identity: { ownerId: this.owner, generation: this.generation, sequence: this.noticeFrameSequence } }) }
    if (!this.matchesNoticeFeedback(frame)) this.noticeFeedbackError = undefined
  }
  private matchesNoticeFeedback(frame: DesktopAssistantFrame | undefined): boolean {
    const event = this.noticeFeedbackError?.event, notice = desktopAssistantNotice(frame, event?.noticeId)
    return event !== undefined && notice !== undefined && event.ownerId === this.owner && event.generation === this.generation
      && event.noticeId === notice.noticeId && event.noticeGeneration === notice.generation && event.noticeKind === notice.kind
      && event.connectionGeneration === notice.connectionGeneration
  }
  private showCommand(cmd: string): Record<string, unknown> {
    const frame = this.frame!
    const notificationHeight = desktopAssistantNotificationHeight(frame, this.notificationExpanded, Boolean(this.noticeError || frame.noticeError))
    const layout = desktopAssistantLayout({ x: 0, y: 280 }, frame.size, notificationHeight, Boolean(frame.caption), [{ x: 0, y: 0, width: 1024, height: 768 }])
    return { cmd, width: layout.bounds.width, height: layout.bounds.height, avatarSize: frame.size, notification: notificationHeight > 0, notificationHeight, caption: Boolean(frame.caption) }
  }
  private noticeEvent(event: Record<string, unknown>): void {
    const notice = desktopAssistantNotice(this.frame, event.ev === 'notice-presented' ? undefined : String(event.noticeId)), identity = this.frame?.identity
    if (!notice || !identity || !this.frame?.visible || !this.owner || event.ownerId !== this.owner
      || event.generation !== identity.generation || event.sequence !== identity.sequence || event.noticeId !== notice.noticeId
      || event.noticeKind !== undefined && event.noticeKind !== notice.kind
      || event.connectionGeneration !== undefined && (!Number.isSafeInteger(event.connectionGeneration) || Number(event.connectionGeneration) < 0)
      || notice.connectionGeneration !== undefined && event.connectionGeneration !== notice.connectionGeneration
      || event.noticeGeneration !== notice.generation || (event.ev === 'notice-action' && !['open', 'dismiss'].includes(String(event.action)))) return
    const presentedKey = JSON.stringify([this.owner, notice.generation, notice.noticeId, notice.kind])
    if (event.ev === 'notice-presented' && (!this.visible || this.presentedNotice === presentedKey)) return
    if (this.noticeEvents.length >= 32) {
      this.noticeError = '通知操作队列已满，请稍后重试'
      this.agent?.send({ cmd: 'notice-result', accepted: false, message: this.noticeError }); return
    }
    const item: DesktopAssistantNoticeEvent = { sequence: ++this.noticeSequence, ownerId: this.owner, generation: this.generation,
      noticeId: notice.noticeId, noticeGeneration: notice.generation, noticeKind: notice.kind, type: event.ev as DesktopAssistantNoticeEvent['type'],
      ...(event.connectionGeneration === undefined ? {} : { connectionGeneration: event.connectionGeneration as number }),
      ...(event.ev === 'notice-action' ? { action: event.action as 'open' | 'dismiss' } : {}) }
    if (item.type === 'notice-presented') {
      try { this.options.onNoticePresented?.(item) } catch {
        // 中心换代或销毁期间没有确认成功时允许伴随页重试，不能伪报已经呈现。
        this.noticeError = '通知呈现确认失败，请稍后重试'
        this.agent?.send({ cmd: 'notice-result', accepted: false, message: this.noticeError }); return
      }
      this.presentedNotice = presentedKey
    }
    this.noticeEvents.push(item)
    this.noticeError = undefined
    if (item.type === 'notice-action') { this.noticeFeedbackError = undefined; this.refreshFrame() }
    // 先通过身份和容量校验，再允许平台恢复主窗口；dismiss/presented 都不改变焦点。
    this.agent?.send({ cmd: 'notice-result', accepted: true })
    if (event.ev === 'notice-action' && event.action === 'open') this.agent?.send({ cmd: 'notice-open' })
  }
  private noticePage(event: Record<string, unknown>): void {
    const identity = this.frame?.identity
    const cursor = event.cursor === null ? undefined : event.cursor
    if (!identity || !this.frame?.visible || !this.owner || event.ownerId !== this.owner || event.generation !== identity.generation
      || event.sequence !== identity.sequence || !this.frame.notificationSnapshot || !this.options.onNoticePage
      || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) return
    const failed = (): void => {
      this.noticeError = '通知列表暂不可用，请重试'
      this.agent?.send({ cmd: 'notice-result', accepted: false, message: this.noticeError })
    }
    try {
      this.options.onNoticePage(cursor as string | undefined)
      void this.refresh().catch(failed)
    } catch { failed() }
  }

  private failed(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.error = message
    void this.stop()
  }

  private stop(): Promise<void> {
    this.generation++
    this.visible = false; this.ready = false
    this.noticeEvents = []; this.noticeError = undefined; this.noticeFeedbackError = undefined; this.layout = undefined; this.presentedNotice = ''; this.noticeFrameKey = ''
    this.notificationExpanded = false
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

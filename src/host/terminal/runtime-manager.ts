import { randomUUID } from 'node:crypto'
import type { PersistentTerminalRecord, TerminalRecordIdentity } from '../../shared/contracts/terminal.js'
import { TerminalAttachmentRegistry, type ManagedTerminalAttachment } from './attachment-registry.js'
import type {
  TerminalRuntimeAdapter,
  TerminalRuntimeIdentity,
  TerminalRuntimeSession,
  TerminalRuntimeType,
} from './runtime-adapter.js'

export interface RuntimeAttachmentInput {
  readonly identity: TerminalRecordIdentity
  readonly generation: string
  readonly streamId: string
  readonly requestedAttachmentId: string
  readonly cols: number
  readonly rows: number
  readonly onData: (data: string) => void
  readonly onExit: (exitCode: number | null) => void
}

/** 统一选择 backend，并确保停用插件时只清理 attach，不结束持久进程。 */
export class TerminalRuntimeManager {
  private readonly adapters = new Map<TerminalRuntimeType, TerminalRuntimeAdapter>()
  private readonly registry = new TerminalAttachmentRegistry()
  private readonly monitors = new Map<string, { readonly runtimeType: TerminalRuntimeType; readonly attachmentId: string }>()

  constructor(adapters: readonly TerminalRuntimeAdapter[]) {
    for (const adapter of adapters) {
      for (const runtimeType of adapter.runtimeTypes) {
        if (this.adapters.has(runtimeType)) throw new Error(`终端 backend 重复注册: ${runtimeType}`)
        this.adapters.set(runtimeType, adapter)
      }
    }
  }

  create(record: PersistentTerminalRecord): Promise<TerminalRuntimeIdentity> {
    return this.adapter(record.runtimeType).create({ session: runtimeSession(record), cols: record.cols, rows: record.rows })
  }

  inspect(record: PersistentTerminalRecord): Promise<TerminalRuntimeIdentity> {
    return this.adapter(record.runtimeType).inspect(runtimeSession(record))
  }

  async attach(record: PersistentTerminalRecord, input: RuntimeAttachmentInput): Promise<ManagedTerminalAttachment> {
    const backend = this.adapter(record.runtimeType)
    const subscriptionId = randomUUID()
    let runtimeAttachmentId: string | undefined
    const earlyData: string[] = []
    let earlyExit: number | null | undefined
    const attachment = await backend.attach({
      session: runtimeSession(record),
      cols: input.cols,
      rows: input.rows,
      onData: (data) => {
        if (runtimeAttachmentId === undefined) {
          earlyData.push(data)
          return
        }
        if (this.registry.isCurrent(subscriptionId, input.generation, runtimeAttachmentId)) input.onData(data)
      },
      onExit: (exitCode) => {
        if (runtimeAttachmentId === undefined) {
          earlyExit = exitCode
          return
        }
        if (this.registry.isCurrent(subscriptionId, input.generation, runtimeAttachmentId)) input.onExit(exitCode)
      },
    })
    runtimeAttachmentId = attachment.attachmentId
    const managed: ManagedTerminalAttachment = {
      identity: { ...input.identity },
      runtimeType: record.runtimeType,
      terminalId: record.terminalId,
      generation: input.generation,
      streamId: input.streamId,
      subscriptionId,
      runtimeAttachmentId,
    }
    this.registry.add(managed)
    for (const data of earlyData) {
      if (this.registry.isCurrent(subscriptionId, input.generation, runtimeAttachmentId)) input.onData(data)
    }
    if (earlyExit !== undefined && this.registry.isCurrent(subscriptionId, input.generation, runtimeAttachmentId)) {
      input.onExit(earlyExit)
    }
    return managed
  }

  async write(subscriptionId: string, data: string): Promise<void> {
    const attachment = this.requireAttachment(subscriptionId)
    await this.adapter(attachment.runtimeType).write({ attachmentId: attachment.runtimeAttachmentId, data })
  }

  /**
   * 在不抢占浏览器 attach 控制权的前提下，向持久终端写入一次启动命令。
   * 这是调试快捷启动所需的“先开 Shell、再发送命令”路径。
   */
  async writeSession(record: PersistentTerminalRecord, data: string): Promise<void> {
    const monitor = this.monitors.get(monitorKey(record))
    const backend = this.adapter(record.runtimeType)
    if (monitor !== undefined) {
      // monitor attach 与持久 Shell 同寿命，不能像临时 attach 一样写完立即销毁。
      await backend.write({ attachmentId: monitor.attachmentId, data })
      return
    }

    const attachment = await backend.attach({
      session: runtimeSession(record),
      cols: record.cols,
      rows: record.rows,
      onData: () => undefined,
    })
    try {
      await backend.write({ attachmentId: attachment.attachmentId, data })
    } finally {
      await backend.detach(attachment.attachmentId)
    }
  }

  async resize(subscriptionId: string, cols: number, rows: number): Promise<void> {
    const attachment = this.requireAttachment(subscriptionId)
    await this.adapter(attachment.runtimeType).resize({ attachmentId: attachment.runtimeAttachmentId, cols, rows })
  }

  async detach(subscriptionId: string): Promise<void> {
    const attachment = this.registry.remove(subscriptionId)
    if (attachment === undefined) return
    await this.adapter(attachment.runtimeType).detach(attachment.runtimeAttachmentId)
  }

  async detachGeneration(generation: string): Promise<void> {
    await Promise.all(this.registry.listByGeneration(generation).map((attachment) => this.detach(attachment.subscriptionId)))
  }

  async detachTerminal(identity: TerminalRecordIdentity): Promise<void> {
    await Promise.all(this.registry.listByTerminal(identity).map((attachment) => this.detach(attachment.subscriptionId)))
  }

  /** 为 Host 进程状态提供退出监听，不获取终端输入控制权。 */
  async monitor(record: PersistentTerminalRecord, onExit: (exitCode: number | null) => void): Promise<void> {
    const key = monitorKey(record)
    if (this.monitors.has(key)) return
    const backend = this.adapter(record.runtimeType)
    const attachment = await backend.attach({
      session: runtimeSession(record),
      cols: record.cols,
      rows: record.rows,
      onData: () => undefined,
      onExit: (exitCode) => {
        this.monitors.delete(key)
        onExit(exitCode)
      },
    })
    this.monitors.set(key, { runtimeType: record.runtimeType, attachmentId: attachment.attachmentId })
  }

  async detachMonitor(record: PersistentTerminalRecord): Promise<void> {
    const key = monitorKey(record)
    const monitor = this.monitors.get(key)
    if (monitor === undefined) return
    this.monitors.delete(key)
    await this.adapter(monitor.runtimeType).detach(monitor.attachmentId)
  }

  async dispose(): Promise<void> {
    await Promise.all(this.registry.list().map((attachment) => this.detach(attachment.subscriptionId)))
    await Promise.all([...this.monitors].map(async ([, monitor]) => this.adapter(monitor.runtimeType).detach(monitor.attachmentId)))
    this.monitors.clear()
    await Promise.all([...new Set(this.adapters.values())].map((adapter) => adapter.dispose?.()))
  }

  async terminate(record: PersistentTerminalRecord): Promise<void> {
    await this.detachMonitor(record)
    await this.adapter(record.runtimeType).terminate(runtimeSession(record))
  }

  private adapter(runtimeType: TerminalRuntimeType): TerminalRuntimeAdapter {
    const adapter = this.adapters.get(runtimeType)
    if (adapter === undefined) throw new Error(`当前 Host 没有终端 backend: ${runtimeType}`)
    return adapter
  }

  private requireAttachment(subscriptionId: string): ManagedTerminalAttachment {
    const attachment = this.registry.get(subscriptionId)
    if (attachment === undefined) throw new Error('终端 attach 不存在或已经释放')
    return attachment
  }

}

function monitorKey(record: Pick<PersistentTerminalRecord, 'hostId' | 'workspaceId' | 'terminalId'>): string {
  return JSON.stringify([record.hostId, record.workspaceId, record.terminalId])
}

function runtimeSession(record: PersistentTerminalRecord): TerminalRuntimeSession {
  return {
    runtimeSessionKey: record.runtimeSessionKey,
    runtimeType: record.runtimeType,
    shellPath: record.shellPath,
    shellArgs: record.shellArgs ?? [],
    ...(record.commandPath === undefined ? {} : { commandPath: record.commandPath }),
    ...(record.commandArgs === undefined ? {} : { commandArgs: record.commandArgs }),
    ...(record.commandEnv === undefined ? {} : { commandEnv: record.commandEnv }),
    cwd: record.cwd,
  }
}

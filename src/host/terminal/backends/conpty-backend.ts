import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  ConptyBrokerClient,
  type ConptyBrokerAttachment,
  type ConptyBrokerClientLike,
} from '../broker/conpty-broker-client.js'
import {
  TerminalRuntimeError,
  type TerminalRuntimeAdapter,
  type TerminalRuntimeAttachInput,
  type TerminalRuntimeAttachment,
  type TerminalRuntimeCreateInput,
  type TerminalRuntimeIdentity,
  type TerminalRuntimeResizeInput,
  type TerminalRuntimeSession,
  type TerminalRuntimeWriteInput,
} from '../runtime-adapter.js'

export interface ConptyBackendOptions {
  readonly platform?: string
  readonly brokerClient?: ConptyBrokerClientLike
  readonly launchBroker?: (input: {
    readonly pipeName: string
    readonly auth: string
    readonly shellPath: string
    readonly shellArgs: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
  }) => void
  readonly startupAttempts?: number
  readonly startupDelayMs?: number
}

/** DSH 进程只启动和连接 broker；真正的 ConPTY 始终由 detached broker 持有。 */
export class ConptyTerminalBackend implements TerminalRuntimeAdapter {
  readonly runtimeTypes = ['conpty-powershell', 'conpty-cmd', 'conpty-git-bash'] as const
  private readonly platform: string
  private readonly brokerClient: ConptyBrokerClientLike
  private readonly launchBroker: NonNullable<ConptyBackendOptions['launchBroker']>
  private readonly startupAttempts: number
  private readonly startupDelayMs: number
  private readonly attachments = new Map<string, ConptyBrokerAttachment>()

  constructor(options: ConptyBackendOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.brokerClient = options.brokerClient ?? new ConptyBrokerClient()
    this.launchBroker = options.launchBroker ?? launchDetachedBroker
    this.startupAttempts = options.startupAttempts ?? 40
    this.startupDelayMs = options.startupDelayMs ?? 50
  }

  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(input.session)
    const existing = await this.tryInspect(input.session)
    if (existing?.alive) return existing
    const pipeName = conptyPipeName(input.session.runtimeSessionKey)
    this.launchBroker({
      pipeName,
      auth: input.session.runtimeSessionKey,
      shellPath: input.session.commandPath ?? input.session.shellPath,
      shellArgs: input.session.commandArgs ?? input.session.shellArgs,
      cwd: input.session.cwd,
      env: { ...process.env, ...(input.session.commandEnv ?? {}), ...(input.env ?? {}) },
    })
    for (let attempt = 0; attempt < this.startupAttempts; attempt += 1) {
      const identity = await this.tryInspect(input.session)
      if (identity?.alive) return identity
      await delay(this.startupDelayMs)
    }
    throw new TerminalRuntimeError('TERMINAL_RUNTIME_CREATE_FAILED', 'ConPTY broker 启动超时')
  }

  async inspect(session: TerminalRuntimeSession): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(session)
    return (await this.tryInspect(session)) ?? {
      alive: false,
      runtimeSessionKey: session.runtimeSessionKey,
      runtimePid: null,
      shellPid: null,
      detail: 'ConPTY broker 不存在或无法连接',
    }
  }

  async attach(input: TerminalRuntimeAttachInput): Promise<TerminalRuntimeAttachment> {
    this.assertSupported(input.session)
    let attachmentId: string | null = null
    const attachment = await this.brokerClient.attach({
      pipeName: conptyPipeName(input.session.runtimeSessionKey),
      auth: input.session.runtimeSessionKey,
      runtimeSessionKey: input.session.runtimeSessionKey,
      cols: input.cols,
      rows: input.rows,
      onData: input.onData,
      onExit: (exitCode) => {
        if (attachmentId !== null) this.attachments.delete(attachmentId)
        input.onExit?.(exitCode)
      },
    })
    attachmentId = attachment.attachmentId
    this.attachments.set(attachment.attachmentId, attachment)
    return { attachmentId: attachment.attachmentId, identity: attachment.identity }
  }

  async write(input: TerminalRuntimeWriteInput): Promise<void> {
    this.getAttachment(input.attachmentId).write(input.data)
  }

  async resize(input: TerminalRuntimeResizeInput): Promise<void> {
    this.getAttachment(input.attachmentId).resize(input.cols, input.rows)
  }

  async detach(attachmentId: string): Promise<void> {
    const attachment = this.attachments.get(attachmentId)
    if (attachment === undefined) return
    this.attachments.delete(attachmentId)
    await attachment.detach()
  }

  async terminate(session: TerminalRuntimeSession): Promise<void> {
    this.assertSupported(session)
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.identity.runtimeSessionKey === session.runtimeSessionKey) await this.detach(attachmentId)
    }
    try {
      await this.brokerClient.terminate(conptyPipeName(session.runtimeSessionKey), session.runtimeSessionKey)
    } catch (error) {
      // 已经消失的 broker 等价于关闭完成，保证显式 close 幂等。
      if (!isUnavailable(error)) throw error
    }
  }

  private async tryInspect(session: TerminalRuntimeSession): Promise<TerminalRuntimeIdentity | null> {
    try {
      return await this.brokerClient.inspect(
        conptyPipeName(session.runtimeSessionKey),
        session.runtimeSessionKey,
        session.runtimeSessionKey,
      )
    } catch (error) {
      if (isUnavailable(error)) return null
      throw error
    }
  }

  private getAttachment(attachmentId: string): ConptyBrokerAttachment {
    const attachment = this.attachments.get(attachmentId)
    if (attachment === undefined) throw new TerminalRuntimeError('TERMINAL_ATTACHMENT_NOT_FOUND', '终端 attach 不存在或已经释放')
    return attachment
  }

  private assertSupported(session: TerminalRuntimeSession): void {
    if (this.platform !== 'win32') {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', 'ConPTY backend 只支持 Windows')
    }
    if (!this.runtimeTypes.includes(session.runtimeType as typeof this.runtimeTypes[number])) {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', `ConPTY backend 不支持 ${session.runtimeType}`)
    }
  }
}

export function conptyPipeName(runtimeSessionKey: string): string {
  const digest = createHash('sha256').update(runtimeSessionKey).digest('hex').slice(0, 40)
  return `\\\\.\\pipe\\dsh-codingns-${digest}`
}

function launchDetachedBroker(input: Parameters<NonNullable<ConptyBackendOptions['launchBroker']>>[0]): void {
  const scriptPath = fileURLToPath(new URL('../broker/conpty-broker-process.js', import.meta.url))
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    scriptPath,
    '--pipe', input.pipeName,
    '--shell', input.shellPath,
    '--cwd', input.cwd,
  ], {
    env: {
      ...input.env,
      DSH_CODINGNS_TERMINAL_AUTH: input.auth,
      DSH_CODINGNS_TERMINAL_ARGS: JSON.stringify(input.shellArgs),
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  })
  child.unref()
}

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: string }).code
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

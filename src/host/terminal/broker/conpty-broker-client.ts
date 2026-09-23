import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  createJsonLineParser,
  parseBrokerMessage,
  writeBrokerMessage,
  type ConptyBrokerMessage,
} from './conpty-broker-protocol.js'
import { TerminalRuntimeError, normalizeTerminalSize, type TerminalRuntimeIdentity } from '../runtime-adapter.js'

const BROKER_REQUEST_TIMEOUT_MS = 5_000

export interface ConptyBrokerAttachment {
  readonly attachmentId: string
  readonly identity: TerminalRuntimeIdentity
  write(data: string): void
  resize(cols: number, rows: number): void
  detach(): Promise<void>
}

export interface ConptyBrokerClientLike {
  inspect(pipeName: string, auth: string, runtimeSessionKey: string): Promise<TerminalRuntimeIdentity>
  attach(input: {
    readonly pipeName: string
    readonly auth: string
    readonly runtimeSessionKey: string
    readonly cols: number
    readonly rows: number
    readonly onData: (data: string) => void
    readonly onExit?: (exitCode: number | null) => void
  }): Promise<ConptyBrokerAttachment>
  terminate(pipeName: string, auth: string): Promise<void>
}

export class ConptyBrokerClient implements ConptyBrokerClientLike {
  async inspect(pipeName: string, auth: string, runtimeSessionKey: string): Promise<TerminalRuntimeIdentity> {
    const message = await requestOnce(pipeName, { version: 1, auth, type: 'inspect' })
    if (message.type !== 'inspect-result') throw protocolError(message)
    return {
      alive: message.alive,
      runtimeSessionKey,
      runtimePid: message.brokerPid,
      shellPid: message.shellPid,
    }
  }

  async attach(input: Parameters<ConptyBrokerClientLike['attach']>[0]): Promise<ConptyBrokerAttachment> {
    const socket = connect(input.pipeName)
    const size = normalizeTerminalSize(input.cols, input.rows)
    const attachmentId = randomUUID()
    let settled = false
    let detached = false
    let finished = false
    return new Promise<ConptyBrokerAttachment>((resolve, reject) => {
      const fail = (error: unknown): void => {
        if (finished) return
        finished = true
        socket.destroy()
        if (!settled) reject(new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', '无法连接 ConPTY broker', { cause: error }))
        else if (!detached) input.onExit?.(null)
        settled = true
      }
      const parser = createJsonLineParser((value) => {
        const message = parseBrokerMessage(value)
        if (message === null) return fail(new Error('broker 返回了无效协议消息'))
        if (message.type === 'error') return fail(protocolError(message))
        if (message.type === 'output') {
          if (!finished) input.onData(message.data)
          return
        }
        if (message.type === 'exit') {
          if (!finished) {
            finished = true
            input.onExit?.(message.exitCode)
            socket.end()
          }
          return
        }
        if (message.type !== 'attached' || settled) return
        settled = true
        const identity: TerminalRuntimeIdentity = {
          alive: true,
          runtimeSessionKey: input.runtimeSessionKey,
          runtimePid: message.brokerPid,
          shellPid: message.shellPid,
        }
        resolve({
          attachmentId,
          identity,
          write(data) {
            if (!detached) writeBrokerMessage(socket, { version: 1, auth: input.auth, type: 'input', data })
          },
          resize(cols, rows) {
            if (detached) return
            const next = normalizeTerminalSize(cols, rows)
            writeBrokerMessage(socket, { version: 1, auth: input.auth, type: 'resize', ...next })
          },
          async detach() {
            if (detached) return
            detached = true
            finished = true
            writeBrokerMessage(socket, { version: 1, auth: input.auth, type: 'detach' })
            socket.end()
          },
        })
      })
      socket.once('connect', () => writeBrokerMessage(socket, { version: 1, auth: input.auth, type: 'attach', ...size }))
      socket.setTimeout(BROKER_REQUEST_TIMEOUT_MS, () => fail(new Error('ConPTY broker attach 响应超时')))
      socket.on('data', (chunk) => {
        try { parser.push(chunk) } catch (error) { fail(error) }
      })
      socket.once('error', fail)
      socket.once('close', () => {
        if (!detached) fail(new Error('broker 连接已经关闭'))
      })
    })
  }

  async terminate(pipeName: string, auth: string): Promise<void> {
    const message = await requestOnce(pipeName, { version: 1, auth, type: 'terminate' })
    if (message.type !== 'terminated') throw protocolError(message)
  }
}

async function requestOnce(
  pipeName: string,
  request: { readonly version: 1; readonly auth: string; readonly type: 'inspect' | 'terminate' },
): Promise<ConptyBrokerMessage> {
  const socket = connect(pipeName)
  return new Promise<ConptyBrokerMessage>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      socket.end()
      action()
    }
    socket.setTimeout(BROKER_REQUEST_TIMEOUT_MS, () => {
      socket.destroy()
      finish(() => reject(new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', 'ConPTY broker 响应超时')))
    })
    const parser = createJsonLineParser((value) => {
      const message = parseBrokerMessage(value)
      if (message === null) finish(() => reject(new TerminalRuntimeError('TERMINAL_BROKER_PROTOCOL_INVALID', 'broker 返回了无效协议消息')))
      else if (message.type === 'error') finish(() => reject(protocolError(message)))
      else finish(() => resolve(message))
    })
    socket.once('connect', () => writeBrokerMessage(socket, request))
    socket.on('data', (chunk) => {
      try { parser.push(chunk) } catch (error) { finish(() => reject(error)) }
    })
    socket.once('error', (error) => finish(() => reject(error)))
    socket.once('close', () => finish(() => reject(new Error('broker 未返回响应'))))
  })
}

function protocolError(message: ConptyBrokerMessage): TerminalRuntimeError {
  if (message.type === 'error' && message.code === 'UNAUTHORIZED') {
    return new TerminalRuntimeError('TERMINAL_BROKER_UNAUTHORIZED', message.message)
  }
  return new TerminalRuntimeError(
    'TERMINAL_BROKER_PROTOCOL_INVALID',
    message.type === 'error' ? message.message : `broker 返回了意外消息：${message.type}`,
  )
}

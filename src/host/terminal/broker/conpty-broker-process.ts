import { timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { spawn } from '@lydell/node-pty'
import {
  BoundedTerminalBuffer,
  ExclusiveAttachmentLease,
  createJsonLineParser,
  parseBrokerRequest,
  writeBrokerMessage,
} from './conpty-broker-protocol.js'
import { normalizeTerminalSize } from '../runtime-adapter.js'

interface BrokerArguments {
  readonly pipeName: string
  readonly auth: string
  readonly shellPath: string
  readonly shellArgs: readonly string[]
  readonly cwd: string
}

export function runConptyBroker(args: BrokerArguments): void {
  if (process.platform !== 'win32') throw new Error('ConPTY broker 只能在 Windows 上运行')
  const pty = spawn(args.shellPath, [...args.shellArgs], {
    cwd: args.cwd,
    env: process.env,
    cols: 120,
    rows: 30,
    name: 'xterm-256color',
  })
  const outputBuffer = new BoundedTerminalBuffer()
  const attachmentLease = new ExclusiveAttachmentLease<Socket>()
  const attachedSockets = new Set<Socket>()
  const terminationWaiters = new Set<Socket>()
  let exited = false

  const server = createServer((socket) => {
    let attached = false
    const parser = createJsonLineParser((value) => {
      const request = parseBrokerRequest(value)
      if (request === null) return fail(socket, 'INVALID_PROTOCOL', '无效的 broker 请求')
      if (!sameSecret(request.auth, args.auth)) return fail(socket, 'UNAUTHORIZED', 'broker 认证失败')

      if (request.type === 'inspect') {
        writeBrokerMessage(socket, { version: 1, type: 'inspect-result', alive: !exited, brokerPid: process.pid, shellPid: pty.pid })
        socket.end()
        return
      }
      if (request.type === 'terminate') {
        if (exited) {
          writeBrokerMessage(socket, { version: 1, type: 'terminated' })
          socket.end()
          return
        }
        terminationWaiters.add(socket)
        try {
          pty.kill()
        } catch {
          terminationWaiters.delete(socket)
          fail(socket, 'TERMINATE_FAILED', 'ConPTY shell 终止失败')
        }
        return
      }
      if (request.type === 'attach') {
        const size = normalizeTerminalSize(request.cols, request.rows)
        attached = true
        attachedSockets.add(socket)
        attachmentLease.takeover(socket)
        pty.resize(size.cols, size.rows)
        writeBrokerMessage(socket, { version: 1, type: 'attached', brokerPid: process.pid, shellPid: pty.pid })
        const buffered = outputBuffer.snapshot()
        if (buffered !== '') writeBrokerMessage(socket, { version: 1, type: 'output', data: buffered })
        return
      }
      if (!attached || !attachmentLease.owns(socket)) return fail(socket, 'NOT_ATTACHED', '连接尚未 attach')
      if (request.type === 'input') pty.write(request.data)
      if (request.type === 'resize') {
        const size = normalizeTerminalSize(request.cols, request.rows)
        pty.resize(size.cols, size.rows)
      }
      if (request.type === 'detach') socket.end()
    })
    socket.on('data', (chunk) => {
      try { parser.push(chunk) } catch { fail(socket, 'INVALID_PROTOCOL', 'broker 控制帧无法解析') }
    })
    const release = (): void => {
      attachmentLease.release(socket)
      attachedSockets.delete(socket)
    }
    socket.once('close', release)
    socket.once('error', release)
  })

  pty.onData((data) => {
    outputBuffer.push(data)
    for (const socket of attachedSockets) writeBrokerMessage(socket, { version: 1, type: 'output', data })
  })
  pty.onExit(({ exitCode }) => {
    exited = true
    for (const socket of attachedSockets) {
      writeBrokerMessage(socket, { version: 1, type: 'exit', exitCode })
      socket.end()
    }
    attachedSockets.clear()
    for (const waiter of terminationWaiters) {
      writeBrokerMessage(waiter, { version: 1, type: 'terminated' })
      waiter.end()
    }
    terminationWaiters.clear()
    server.close(() => undefined)
  })
  // readableAll/writableAll=false 明确要求 Windows 使用当前用户的默认 Named Pipe ACL。
  server.listen({ path: args.pipeName, readableAll: false, writableAll: false })
}

function fail(socket: Socket, code: string, message: string): void {
  writeBrokerMessage(socket, { version: 1, type: 'error', code, message })
  socket.end()
}

function sameSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(actual)
  const right = encoder.encode(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function readArguments(argv: readonly string[]): BrokerArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name?.startsWith('--') && value !== undefined) values.set(name.slice(2), value)
  }
  const pipeName = values.get('pipe')
  const auth = values.get('auth') ?? process.env.DSH_CODINGNS_TERMINAL_AUTH
  const shellPath = values.get('shell')
  const cwd = values.get('cwd')
  const shellArgs = parseShellArgs(process.env.DSH_CODINGNS_TERMINAL_ARGS)
  if (!pipeName || !auth || !shellPath || !cwd) throw new Error('ConPTY broker 启动参数不完整')
  return { pipeName, auth, shellPath, shellArgs, cwd }
}

function parseShellArgs(value: string | undefined): readonly string[] {
  if (value === undefined) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('ConPTY shell 参数无效')
  }
  return parsed
}

runConptyBroker(readArguments(process.argv.slice(2)))

/**
 * 在 WorkBuddy 自带的 Electron 内初始化 CLI 的字段加密；Host 不接收密钥或登录令牌。
 * 协议参考 codex-host 的 WorkBuddy credential-bootstrap.ts（LGPL-3.0）：
 * https://github.com/BytePioneer-AI/codex-host/tree/78106589d07d3ad7af1079e3252afa30c2062477/packages/adapters/workbuddy
 * 2026-11-05：改为 TypeScript 初始化函数，补充连接、定时器和退出清理。
 * 上游许可原文见 THIRD_PARTY_NOTICES；GPL v3 原文见 LICENSE。
 */
function initializeWorkBuddyCredentials(): void {
  const environment = process.env
  const bootstrapVariables = [
    'CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET',
    'CODEBUDDY_SIDECAR_READY_SOCKET',
    'CODEBUDDY_SIDECAR_READY_TOKEN',
    'CODEBUDDY_SIDECAR_READY_SESSION_ID',
  ]
  if (bootstrapVariables.some((name) => environment[name] !== undefined)) {
    if (!['WORKBUDDY_AT_REST_ENCRYPTION', ...bootstrapVariables].every((name) => environment[name]?.trim())) {
      throw new Error('WorkBuddy credential bootstrap environment is incomplete')
    }
    return
  }
  const policy = environment.WORKBUDDY_AT_REST_ENCRYPTION?.trim()
  if (policy && policy !== 'fields') return

  let storage: { loggerGet(): string }
  try {
    storage = (process as unknown as { _linkedBinding(name: string): typeof storage })._linkedBinding('electron_browser_workbuddy_storage')
  } catch {
    // 旧版应用没有字段加密绑定，认证继续由它自己的 CLI 处理。
    return
  }
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const net = require('node:net') as typeof import('node:net')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  let payload: { version?: unknown; atRestSecretKey?: unknown }
  try { payload = JSON.parse(storage.loggerGet()) as typeof payload }
  catch { throw new Error('WorkBuddy credential key provider is unavailable') }
  let secret = payload?.atRestSecretKey
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'base64') : Buffer.alloc(0)
  const supported = payload?.version === 1 && bytes.length === 32
    && bytes.toString('base64') === secret && !bytes.every((byte) => byte === 0)
  bytes.fill(0)
  if (!supported || typeof secret !== 'string') throw new Error('WorkBuddy credential key payload is unsupported')
  // 原生 normalizeAtRestKeyPayload 哈希的是 base64 文本，而非解码后的字节。
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest()
  secret = undefined
  payload = {}
  const token = crypto.randomBytes(24).toString('hex')
  const sessionId = crypto.randomUUID()
  let directory: string | undefined
  let socketPath: string
  if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\codingns-wb-${process.pid}-${token}`
  } else {
    const temp = (require('node:os') as typeof import('node:os')).tmpdir()
    directory = fs.mkdtempSync(path.join(Buffer.byteLength(temp) > 65 ? '/tmp' : temp, 'codingns-wb-'))
    fs.chmodSync(directory, 0o700)
    socketPath = path.join(directory, 'c')
  }

  let socket: import('node:net').Socket | undefined
  let server: import('node:net').Server | undefined
  const connections = new Set<import('node:net').Socket>()
  let credentialTimer: ReturnType<typeof setTimeout> | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let credentialReady = false
  let runtimeReady = !process.argv.includes('--serve')
  let finished = false
  let message = `${JSON.stringify({
    version: 1, sessionId, token, pid: process.pid,
    bootstrap: {
      version: 1, policy: 'fields',
      symmetricKey: { keyId: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16), keyBase64: key.toString('base64') },
      asymmetricUnavailable: 'missing-key',
    },
  })}\n`
  key.fill(0)
  const terminate = (): never => process.exit(143)
  const cleanup = (): void => {
    clearTimeout(credentialTimer)
    clearTimeout(readyTimer)
    clearTimeout(retryTimer)
    socket?.destroy()
    server?.close()
    for (const connection of connections) connection.destroy()
    if (directory !== undefined) {
      try { fs.rmSync(directory, { recursive: true, force: true }) } catch { /* 仅清理本次引导的临时目录 */ }
    }
    message = ''
    process.removeListener('exit', cleanup)
    process.removeListener('SIGTERM', terminate)
  }
  const fail = (reason: string): void => {
    if (finished) return
    finished = true
    cleanup()
    process.stderr.write(`WorkBuddy credential bootstrap failed: ${reason}\n`)
    process.exit(1)
  }
  const complete = (): void => {
    if (!credentialReady || !runtimeReady || finished) return
    finished = true
    cleanup()
  }
  process.once('exit', cleanup)
  process.once('SIGTERM', terminate)

  if (!runtimeReady) {
    server = net.createServer((connection) => {
      connections.add(connection)
      connection.once('close', () => connections.delete(connection))
      connection.on('error', () => connection.destroy())
      let buffer = ''
      connection.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (buffer.length > 4096) { connection.destroy(); return }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const request = JSON.parse(buffer.slice(0, newline)) as {
            jsonrpc?: unknown; id?: unknown; method?: unknown
            params?: { protocolVersion?: unknown; token?: unknown; sessionId?: unknown; pid?: unknown; port?: unknown }
          }
          const params = request.params
          if (request.jsonrpc !== '2.0' || request.method !== 'session.ready' || typeof request.id !== 'string'
            || params?.protocolVersion !== 1 || params.token !== token || params.sessionId !== sessionId
            || params.pid !== process.pid || !Number.isInteger(params.port) || Number(params.port) < 1 || Number(params.port) > 65535) {
            connection.destroy()
            return
          }
          runtimeReady = true
          connection.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`, complete)
        } catch { connection.destroy() }
      })
    })
    server.once('error', () => fail('runtime readiness listener unavailable'))
    server.listen(`${socketPath}-ready`)
    readyTimer = setTimeout(() => fail('runtime readiness timed out'), 15_000)
  }
  Object.assign(environment, {
    WORKBUDDY_AT_REST_ENCRYPTION: 'fields',
    CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: socketPath,
    CODEBUDDY_SIDECAR_READY_SOCKET: `${socketPath}-ready`,
    CODEBUDDY_SIDECAR_READY_TOKEN: token,
    CODEBUDDY_SIDECAR_READY_SESSION_ID: sessionId,
  })
  const connect = (): void => {
    if (finished || credentialReady) return
    const connection = net.createConnection(socketPath)
    socket = connection
    let reply = ''
    connection.once('connect', () => connection.end(message, () => { message = '' }))
    connection.on('data', (chunk: Buffer) => {
      reply += chunk.toString('utf8')
      if (reply.length > 1024) { fail('invalid acknowledgement'); return }
      const newline = reply.indexOf('\n')
      if (newline < 0) return
      try {
        const acknowledgement = JSON.parse(reply.slice(0, newline)) as { ok?: unknown; policy?: unknown }
        if (acknowledgement.ok !== true || acknowledgement.policy !== 'fields') { fail('initialization rejected'); return }
        credentialReady = true
        clearTimeout(credentialTimer)
        connection.destroy()
        complete()
      } catch { fail('invalid acknowledgement') }
    })
    connection.once('end', () => { if (!credentialReady) fail('acknowledgement missing') })
    connection.once('error', (error: NodeJS.ErrnoException) => {
      connection.destroy()
      if (finished || credentialReady) return
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') retryTimer = setTimeout(connect, 20)
      else fail('credential receiver unavailable')
    })
  }
  credentialTimer = setTimeout(() => fail('credential receiver timed out'), 4_500)
  setImmediate(connect)
}

// 函数只使用子进程的 Node 内建对象；序列化发生在 TypeScript 编译之后。
export const WORKBUDDY_CREDENTIAL_PRELOAD = `(${initializeWorkBuddyCredentials.toString()})();`

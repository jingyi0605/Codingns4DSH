import { createHash, randomBytes } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  CredentialBrokerBinding,
  CredentialBrokerDescription,
  CredentialBrokerIssueResult,
  CredentialBrokerProcessEnvironment,
  CredentialEnvironmentBinding,
  CredentialReference,
} from '../../shared/contracts/credentials.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { CredentialService } from './service.js'

const REQUEST_TTL_MS = 8 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024

export interface CredentialBrokerOptions {
  readonly service: CredentialService
  readonly now?: () => number
  readonly requestTtlMs?: number
  readonly cleanupIntervalMs?: number
  readonly spawn?: typeof spawn
  readonly cliModulePath?: string
}

export interface CredentialBrokerCommandResult {
  readonly exitCode: number | null
  readonly signal?: string
  readonly stdout: string
  readonly stderr: string
}

interface Grant {
  readonly sessionId: string
  readonly credentialId: string
  readonly bindings: readonly CredentialEnvironmentBinding[]
  readonly label: string
  readonly brokerBindings: readonly CredentialBrokerBinding[]
  readonly requestCode: string
  readonly expiresAt: number
  readonly requestCodeHash: string
  handle?: string
  handleHash?: string
  revoked: boolean
}

interface SessionAccess {
  readonly sessionId: string
  readonly token: string
}

interface BrokerRequest {
  readonly action: 'describe' | 'exec'
  readonly token: string
  readonly code?: string
  readonly handle?: string
  readonly argv?: readonly string[]
  readonly cwd?: string
}

interface BrokerResponse {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

export class CredentialBroker {
  private readonly service: CredentialService
  private readonly now: () => number
  private readonly requestTtlMs: number
  private readonly cleanupIntervalMs: number
  private readonly runSpawn: typeof spawn
  private readonly cliModulePath: string
  private readonly grants = new Map<string, Grant>()
  private readonly sessionAccess = new Map<string, SessionAccess>()
  private readonly children = new Map<ChildProcess, number>()
  private server: Server | undefined
  private endpoint: string | undefined
  private binDirectory: string | undefined
  private askpassPath: string | undefined
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private socketDirectory: string | undefined
  private active = false
  private nativeTool = false

  constructor(options: CredentialBrokerOptions) {
    this.service = options.service
    this.now = options.now ?? Date.now
    this.requestTtlMs = Math.max(1_000, options.requestTtlMs ?? REQUEST_TTL_MS)
    this.cleanupIntervalMs = Math.max(1_000, options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS)
    this.runSpawn = options.spawn ?? spawn
    this.cliModulePath = options.cliModulePath ?? defaultCliModulePath()
  }

  async activate(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      this.socketDirectory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'codingns-credential-broker-'))
      this.server = createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket))
      if (process.platform === 'win32') {
        await listenServer(this.server, 0, '127.0.0.1')
        const address = this.server.address()
        if (address === null || typeof address === 'string') throw brokerError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker endpoint is unavailable')
        this.endpoint = `tcp://${address.address}:${String(address.port)}`
      } else {
        const socketPath = join(this.socketDirectory, 'broker.sock')
        await listenServer(this.server, socketPath)
        this.endpoint = `unix:${socketPath}`
      }
      this.binDirectory = await this.createCliDirectory()
      this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs)
      this.cleanupTimer.unref?.()
    } catch (error) {
      await this.deactivate()
      if (error instanceof CodingNsRpcError) throw error
      throw brokerError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker is unavailable')
    }
  }

  async deactivate(): Promise<void> {
    this.active = false
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    for (const child of this.children.keys()) child.kill('SIGTERM')
    this.children.clear()
    this.grants.clear()
    this.sessionAccess.clear()
    this.endpoint = undefined
    if (this.server !== undefined) {
      await closeServer(this.server)
      this.server = undefined
    }
    if (this.binDirectory !== undefined) await rm(this.binDirectory, { recursive: true, force: true }).catch(() => undefined)
    this.binDirectory = undefined
    this.askpassPath = undefined
    if (this.socketDirectory !== undefined) await rm(this.socketDirectory, { recursive: true, force: true }).catch(() => undefined)
    this.socketDirectory = undefined
  }

  async issue(input: {
    readonly sessionId: string
    readonly credentialId: string
    readonly bindings?: readonly CredentialEnvironmentBinding[]
    readonly reuseExisting?: boolean
  }): Promise<CredentialBrokerIssueResult> {
    this.ensureActive()
    const sessionId = requireText(input.sessionId, 'session id')
    const reference = await this.referenceFor(input.credentialId, input.bindings)
    const metadata = await this.service.metadataFor(reference.credentialId)
    const bindings = toBrokerBindings(metadata, reference.bindings)
    const existing = input.reuseExisting === true
      ? [...this.grants.values()].find((grant) => grant.sessionId === sessionId
      && grant.credentialId === reference.credentialId
      && !grant.revoked
      && grant.expiresAt > this.now()
      && JSON.stringify(grant.bindings) === JSON.stringify(reference.bindings))
      : undefined
    if (existing !== undefined) {
      return {
        requestCode: existing.requestCode,
        label: existing.label,
        expiresAt: new Date(existing.expiresAt).toISOString(),
        bindings: existing.brokerBindings,
      }
    }
    const requestCode = randomToken()
    const grant: Grant = {
      sessionId,
      credentialId: reference.credentialId,
      bindings: reference.bindings,
      label: metadata.label,
      brokerBindings: bindings,
      requestCode,
      expiresAt: this.now() + this.requestTtlMs,
      requestCodeHash: hashToken(requestCode),
      revoked: false,
    }
    this.grants.set(grant.requestCodeHash, grant)
    return {
      requestCode,
      label: metadata.label,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      bindings,
    }
  }

  async issueDefault(sessionId: string, credentialId: string, reuseExisting = false): Promise<CredentialBrokerIssueResult> {
    const reference = await this.service.defaultReference(credentialId)
    return this.issue({ sessionId, credentialId, bindings: reference.bindings, reuseExisting })
  }

  describeRequest(sessionId: string, requestCode: string): CredentialBrokerDescription {
    this.ensureActive()
    const grant = this.findRequest(sessionId, requestCode)
    const handle = grant.handle ?? randomToken()
    if (grant.handle === undefined) {
      grant.handle = handle
      grant.handleHash = hashToken(handle)
    }
    return {
      handle,
      label: grant.label,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      bindings: this.bindingsForGrant(grant),
    }
  }

  describeHandle(sessionId: string, handle: string): CredentialBrokerDescription {
    this.ensureActive()
    const grant = this.grantForHandle(sessionId, handle)
    return {
      handle,
      label: grant.label,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      bindings: this.bindingsForGrant(grant),
    }
  }

  async executeRequest(input: {
    readonly sessionId: string
    readonly requestCode?: string
    readonly handle?: string
    readonly argv: readonly string[]
    readonly cwd?: string
  }): Promise<CredentialBrokerCommandResult> {
    this.ensureActive()
    const grant = input.requestCode === undefined
      ? this.grantForHandle(input.sessionId, input.handle ?? '')
      : this.findRequest(input.sessionId, input.requestCode)
    if (input.argv.length === 0 || input.argv.some((item) => typeof item !== 'string')) {
      throw brokerError('CREDENTIAL_INVALID', 'Credential command is empty')
    }
    const values = await this.service.resolve({
      credentialId: grant.credentialId,
      bindings: grant.bindings,
    })
    const environment = { ...process.env, ...values }
    delete environment.CODINGNS_CREDENTIAL_BROKER_ENDPOINT
    delete environment.CODINGNS_CREDENTIAL_BROKER_TOKEN
    delete environment.CODINGNS_CREDENTIAL_SESSION
    const askpassBinding = grant.brokerBindings.find((binding) => binding.usages.includes('ssh.askpass'))
    if (askpassBinding !== undefined && this.askpassPath !== undefined) {
      environment.SSH_ASKPASS = this.askpassPath
      environment.SSH_ASKPASS_REQUIRE = 'force'
      environment.CODINGNS_CREDENTIAL_ASKPASS_ENV = askpassBinding.env
      if (environment.DISPLAY === undefined || environment.DISPLAY === '') environment.DISPLAY = 'codingns:0'
    }
    const [command, ...args] = input.argv
    const child = this.runSpawn(command!, args, {
      cwd: input.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    this.children.set(child, grant.expiresAt)
    const stdout = collectOutput(child.stdout, MAX_OUTPUT_BYTES)
    const stderr = collectOutput(child.stderr, MAX_OUTPUT_BYTES)
    const result = await new Promise<CredentialBrokerCommandResult>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        Promise.all([stdout, stderr]).then(([out, err]) => resolve({
          exitCode,
          ...(signal === null ? {} : { signal }),
          stdout: out,
          stderr: err,
        }), reject)
      })
    }).finally(() => {
      this.children.delete(child)
    })
    return result
  }

  inspectRequest(sessionId: string, requestCode: string): CredentialBrokerDescription {
    this.ensureActive()
    const grant = this.findRequest(sessionId, requestCode)
    return {
      handle: '',
      label: grant.label,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      bindings: this.bindingsForGrant(grant),
    }
  }

  async resolveCarrier(sessionId: string, requestCode: string, label: string): Promise<CredentialBrokerIssueResult> {
    try {
      const description = this.inspectRequest(sessionId, requestCode)
      return {
        requestCode,
        label: description.label || label,
        expiresAt: description.expiresAt,
        bindings: description.bindings,
      }
    } catch (error) {
      if (!(error instanceof CodingNsRpcError) || error.code !== 'CREDENTIAL_REQUEST_INVALID') throw error
      // Messages written by the previous carrier format contained a stable
      // credential ID. Convert those carriers once at the Host boundary.
      return this.issueDefault(sessionId, requestCode)
    }
  }

  processEnvironment(sessionId: string): CredentialBrokerProcessEnvironment {
    this.ensureActive()
    const normalized = requireText(sessionId, 'session id')
    const access = this.sessionAccess.get(normalized) ?? { sessionId: normalized, token: randomToken() }
    this.sessionAccess.set(normalized, access)
    const endpoint = this.endpoint
    const path = this.binDirectory
    if (endpoint === undefined || path === undefined) throw brokerError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker endpoint is unavailable')
    return {
      endpoint,
      token: access.token,
      sessionId: access.sessionId,
      path: `${path}${delimiter}${process.env.PATH ?? ''}`,
    }
  }

  revokeSession(sessionId: string): void {
    const normalized = sessionId.trim()
    if (normalized === '') return
    this.sessionAccess.delete(normalized)
    for (const grant of this.grants.values()) {
      if (grant.sessionId === normalized) grant.revoked = true
    }
    this.cleanup()
  }

  revokeCredential(credentialId: string): void {
    const normalized = credentialId.trim()
    for (const grant of this.grants.values()) {
      if (grant.credentialId === normalized) grant.revoked = true
    }
    this.cleanup()
  }

  setNativeToolAvailable(value: boolean): void {
    this.nativeTool = value
  }

  nativeToolAvailable(): boolean {
    return this.nativeTool
  }

  get validityMs(): number {
    return this.requestTtlMs
  }

  cleanup(): void {
    const now = this.now()
    for (const [key, grant] of this.grants) {
      if (grant.revoked || grant.expiresAt <= now) this.grants.delete(key)
    }
    for (const [child, expiresAt] of this.children) {
      if (expiresAt <= now) {
        child.kill('SIGTERM')
        this.children.delete(child)
      }
    }
  }

  private async referenceFor(credentialId: string, bindings?: readonly CredentialEnvironmentBinding[]): Promise<CredentialReference> {
    if (bindings !== undefined) return { credentialId, bindings }
    return this.service.defaultReference(credentialId)
  }

  private bindingsForGrant(grant: Grant): readonly CredentialBrokerBinding[] {
    return grant.brokerBindings
  }

  private findRequest(sessionId: string, requestCode: string): Grant {
    const grant = this.grants.get(hashToken(requestCode))
    if (grant === undefined) throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential request code is invalid')
    if (grant.sessionId !== sessionId.trim()) throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential request code is bound to another session')
    if (grant.expiresAt <= this.now()) {
      grant.revoked = true
      throw brokerError('CREDENTIAL_REQUEST_EXPIRED', 'Credential request code has expired')
    }
    if (grant.revoked) throw brokerError('CREDENTIAL_REQUEST_REVOKED', 'Credential request code has been revoked')
    return grant
  }

  private grantForHandle(sessionId: string, handle: string): Grant {
    const hash = hashToken(handle)
    const grant = [...this.grants.values()].find((item) => item.handleHash === hash)
    if (grant === undefined) throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential handle is invalid')
    if (grant.sessionId !== sessionId.trim()) throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential handle is bound to another session')
    if (grant.expiresAt <= this.now()) {
      grant.revoked = true
      throw brokerError('CREDENTIAL_REQUEST_EXPIRED', 'Credential handle has expired')
    }
    if (grant.revoked) throw brokerError('CREDENTIAL_REQUEST_REVOKED', 'Credential handle has been revoked')
    return grant
  }

  private async createCliDirectory(): Promise<string> {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'codingns-credential-bin-'))
    const source = await readFile(this.cliModulePath)
    if (process.platform === 'win32') {
      const moduleTarget = join(directory, 'codingns-credential.mjs')
      await writeFile(moduleTarget, source, { mode: 0o700 })
      await writeFile(join(directory, 'codingns-credential.cmd'), `@node "${moduleTarget}" %*\r\n`, { mode: 0o700 })
      const askpassModule = join(directory, 'codingns-credential-askpass.mjs')
      await writeFile(askpassModule, askpassSource(), { mode: 0o700 })
      this.askpassPath = join(directory, 'codingns-credential-askpass.cmd')
      await writeFile(this.askpassPath, `@node "${askpassModule}"\r\n`, { mode: 0o700 })
    } else {
      const target = join(directory, 'codingns-credential')
      await writeFile(target, source, { mode: 0o700 })
      await chmod(target, 0o700)
      this.askpassPath = join(directory, 'codingns-credential-askpass')
      await writeFile(this.askpassPath, askpassSource(), { mode: 0o700 })
      await chmod(this.askpassPath, 0o700)
    }
    return directory
  }

  private handleSocket(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      void this.handleRequest(line).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`)
      }, (error) => {
        const rpcError = error instanceof CodingNsRpcError ? error : brokerError('CREDENTIAL_COMMAND_FAILED', 'Credential broker request failed')
        socket.end(`${JSON.stringify({ ok: false, error: { code: rpcError.code, message: rpcError.message } })}\n`)
      })
    })
  }

  private async handleRequest(line: string): Promise<BrokerResponse> {
    let request: BrokerRequest
    try {
      request = JSON.parse(line) as BrokerRequest
    } catch {
      throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential broker request is invalid')
    }
    const access = [...this.sessionAccess.values()].find((item) => item.token === request.token)
    if (access === undefined) throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential broker authentication failed')
    if (request.action === 'describe') {
      if (request.code !== undefined) return { ok: true, value: this.describeRequest(access.sessionId, request.code) }
      return { ok: true, value: this.describeHandle(access.sessionId, request.handle ?? '') }
    }
    if (request.action === 'exec') {
      const commandInput = {
        sessionId: access.sessionId,
        argv: request.argv ?? [],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.code === undefined ? { handle: request.handle ?? '' } : { requestCode: request.code }),
      } as const
      const value = await this.executeRequest(commandInput)
      return { ok: true, value }
    }
    throw brokerError('CREDENTIAL_REQUEST_INVALID', 'Credential broker action is invalid')
  }

  private ensureActive(): void {
    if (!this.active) throw brokerError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker is unavailable')
  }
}

function askpassSource(): string {
  return '#!/usr/bin/env node\nconst name = process.env.CODINGNS_CREDENTIAL_ASKPASS_ENV;\nif (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) process.stdout.write(`${process.env[name] ?? ""}\\n`);\n'
}

function toBrokerBindings(
  metadata: Awaited<ReturnType<CredentialService['metadataFor']>>,
  bindings: readonly CredentialEnvironmentBinding[],
): readonly CredentialBrokerBinding[] {
  return bindings.map((binding) => {
    const field = metadata.fields.find((item) => item.name === binding.field)
    if (field === undefined) throw brokerError('CREDENTIAL_FIELD_NOT_FOUND', 'Credential field not found')
    return {
      field: binding.field,
      env: binding.env,
      kind: field.kind,
      usages: field.usages,
    }
  })
}

function collectOutput(stream: NodeJS.ReadableStream | null, limit: number): Promise<string> {
  if (stream === null) return Promise.resolve('')
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(output)
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      output = `${output}${String(chunk)}`
      if (Buffer.byteLength(output, 'utf8') > limit) output = output.slice(-limit)
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
  })
}

function listenServer(server: Server, portOrPath: number | string, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if (typeof portOrPath === 'number') server.listen(portOrPath, host)
    else server.listen(portOrPath)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized === '') throw brokerError('CREDENTIAL_INVALID', `Credential ${name} is required`)
  return normalized
}

function brokerError(code: string, message: string): CodingNsRpcError {
  return new CodingNsRpcError(code as never, message)
}

function defaultCliModulePath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return join(moduleDirectory, '../../../../../', 'bin', 'codingns-credential.mjs')
}

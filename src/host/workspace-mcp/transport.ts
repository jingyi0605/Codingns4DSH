import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WorkspaceMcpTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export interface WorkspaceMcpTransportOptions {
  /** Missing or empty keys leave the transport inactive; there is no anonymous mode. */
  readonly apiKey?: string
  readonly listTools: (signal: AbortSignal) => readonly WorkspaceMcpTool[] | Promise<readonly WorkspaceMcpTool[]>
  readonly callTool: (name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => unknown | Promise<unknown>
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly maxBodyBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentRequests?: number
  readonly maxConcurrentCalls?: number
  readonly maxWaitMs?: number
}

export interface WorkspaceMcpTransport {
  readonly active: boolean
  readonly url: string | null
  /** Invalidates the key immediately, aborts active tool calls, and closes the listener. */
  revoke(): Promise<void>
  /** Stops accepting requests and lets admitted requests finish within their configured bound. */
  close(): Promise<void>
}

const HOST = '127.0.0.1'
const PATH = '/mcp'
const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]
const SUPPORTED_VERSIONS = ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS] as const
const SUPPORTED_LEGACY_PROTOCOL_VERSIONS = new Set(SUPPORTED_PROTOCOL_VERSIONS)
const MAX_API_KEY_BYTES = 4096
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16
const DEFAULT_MAX_CONCURRENT_CALLS = 8
const DEFAULT_MAX_WAIT_MS = 30_000
const HARD_MAX_BODY_BYTES = 4 * 1024 * 1024
const HARD_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const HARD_MAX_CONCURRENT_REQUESTS = 64
const HARD_MAX_CONCURRENT_CALLS = 32
const HARD_MAX_WAIT_MS = 60_000
const MIN_RESPONSE_BYTES = 128
const MODERN_PROTOCOL_VERSION = '2026-07-28'

interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: unknown
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/**
 * Starts the HTTP binding for the workspace MCP JSON-RPC subset. Tool discovery and
 * execution remain injected callbacks so feature ownership stays outside this module.
 */
export async function startWorkspaceMcpTransport(options: WorkspaceMcpTransportOptions): Promise<WorkspaceMcpTransport> {
  const apiKey = options.apiKey
  if (typeof apiKey !== 'string' || apiKey.length === 0) return inactiveTransport()
  if (Buffer.byteLength(apiKey, 'utf8') > MAX_API_KEY_BYTES) throw new RangeError('Workspace MCP API key is too long')

  const limits = {
    maxBodyBytes: boundedOption(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES),
    maxResponseBytes: boundedOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, HARD_MAX_RESPONSE_BYTES, MIN_RESPONSE_BYTES),
    maxConcurrentRequests: boundedOption(options.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS, HARD_MAX_CONCURRENT_REQUESTS),
    maxConcurrentCalls: boundedOption(options.maxConcurrentCalls, DEFAULT_MAX_CONCURRENT_CALLS, HARD_MAX_CONCURRENT_CALLS),
    maxWaitMs: boundedOption(options.maxWaitMs, DEFAULT_MAX_WAIT_MS, HARD_MAX_WAIT_MS),
  }

  let currentKey: string | null = apiKey
  let closed = false
  let revoked = false
  let activeRequests = 0
  let activeCalls = 0
  const lifetime = new AbortController()
  let closePromise: Promise<void> | undefined
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (closed) {
      writeJson(response, 503, { error: 'transport unavailable' }, limits.maxResponseBytes)
      return
    }
    if (activeRequests >= limits.maxConcurrentRequests) {
      response.setHeader('connection', 'close')
      writeJson(response, 503, { error: 'request capacity exceeded' }, limits.maxResponseBytes)
      return
    }
    activeRequests += 1
    void handleHttpRequest(request, response, options, limits, () => currentKey, () => activeCalls, (delta) => { activeCalls += delta }, lifetime.signal)
      .catch(() => {
        writeJson(response, 500, { error: 'internal server error' }, limits.maxResponseBytes)
      })
      .finally(() => { activeRequests -= 1 })
  })
  server.requestTimeout = HARD_MAX_WAIT_MS + 10_000
  server.headersTimeout = 10_000

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(0, HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Workspace MCP listener did not bind to a TCP address')
  }
  const url = `http://${HOST}:${String(address.port)}${PATH}`

  const stop = (revoke: boolean): Promise<void> => {
    if (revoke && !revoked) {
      revoked = true
      currentKey = null
      lifetime.abort()
    }
    if (closePromise !== undefined) return closePromise
    closed = true
    closePromise = new Promise<void>((resolve) => {
      server.close(() => {
        currentKey = null
        resolve()
      })
      server.closeIdleConnections()
    })
    return closePromise
  }

  return {
    get active() { return !closed },
    url,
    revoke: () => stop(true),
    close: () => stop(false),
  }
}

function inactiveTransport(): WorkspaceMcpTransport {
  return {
    active: false,
    url: null,
    revoke: async () => undefined,
    close: async () => undefined,
  }
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceMcpTransportOptions,
  limits: { readonly maxBodyBytes: number; readonly maxResponseBytes: number; readonly maxConcurrentCalls: number; readonly maxWaitMs: number },
  getKey: () => string | null,
  getActiveCalls: () => number,
  adjustActiveCalls: (delta: number) => void,
  lifetime: AbortSignal,
): Promise<void> {
  const requestLifetime = new AbortController()
  const abortRequest = (): void => requestLifetime.abort()
  request.once('aborted', abortRequest)
  response.once('close', () => { if (!response.writableEnded) abortRequest() })
  const requestSignal = AbortSignal.any([lifetime, requestLifetime.signal])
  const key = getKey()
  if (key === null || !authorized(request, key)) {
    writeJson(response, 401, { error: 'unauthorized' }, limits.maxResponseBytes)
    return
  }
  const origin = request.headers.origin
  if (typeof origin === 'string' && !isSafeLoopbackOrigin(origin)) {
    writeJson(response, 403, { error: 'forbidden origin' }, limits.maxResponseBytes)
    return
  }
  if (request.url !== PATH) {
    writeJson(response, 404, { error: 'not found' }, limits.maxResponseBytes)
    return
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    writeJson(response, 405, { error: 'method not allowed' }, limits.maxResponseBytes)
    return
  }
  if (!isJsonContentType(request.headers['content-type'])) {
    writeJson(response, 415, { error: 'application/json required' }, limits.maxResponseBytes)
    return
  }
  const contentLength = parseContentLength(request.headers['content-length'])
  if (contentLength !== undefined && contentLength > limits.maxBodyBytes) {
    request.resume()
    writeJson(response, 413, { error: 'request body too large' }, limits.maxResponseBytes)
    return
  }
  const body = await readBody(request, response, limits.maxBodyBytes)
  if (body === undefined) {
    writeJson(response, 413, { error: 'request body too large' }, limits.maxResponseBytes)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    writeRpc(response, 400, rpcError(null, -32700, 'Parse error'), limits.maxResponseBytes)
    return
  }
  const requestMessage = parseRequest(parsed)
  if (requestMessage === undefined) {
    writeRpc(response, 400, rpcError(null, -32600, 'Invalid Request'), limits.maxResponseBytes)
    return
  }
  if (!acceptsMcpResponse(request.headers.accept)) {
    writeJson(response, 406, { error: 'application/json and text/event-stream are required in Accept' }, limits.maxResponseBytes)
    return
  }
  const modernRequest = isModernRequest(requestMessage)
  const protocolVersion = modernRequest ? String(protocolVersionFromMeta(requestMessage)) : String(request.headers['mcp-protocol-version'] ?? DEFAULT_PROTOCOL_VERSION)
  let toolCatalog: readonly WorkspaceMcpTool[] | undefined
  if (modernRequest) {
    const requestedVersion = protocolVersionFromMeta(requestMessage)
    const headerVersion = request.headers['mcp-protocol-version']
    if (typeof requestedVersion !== 'string' || typeof headerVersion !== 'string' || requestedVersion !== headerVersion) {
      writeRpc(response, 400, rpcError(requestMessage.id ?? null, -32020, 'Protocol version header mismatch'), limits.maxResponseBytes)
      return
    }
    if (requestedVersion !== '2026-07-28') {
      writeRpc(response, 400, {
        ...rpcError(requestMessage.id ?? null, -32022, 'Unsupported protocol version'),
        error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested: requestedVersion } },
      }, limits.maxResponseBytes)
      return
    }
    if (!hasClientInfoMeta(requestMessage)) {
      writeRpc(response, 400, rpcError(requestMessage.id ?? null, -32021, 'Missing required client metadata'), limits.maxResponseBytes)
      return
    }
    if (request.headers['mcp-method'] !== requestMessage.method) {
      writeRpc(response, 400, rpcError(requestMessage.id ?? null, -32020, 'Mcp-Method header mismatch'), limits.maxResponseBytes)
      return
    }
    if (requestMessage.method === 'tools/call') {
      const name = asRecord(requestMessage.params)?.name
      if (typeof name !== 'string' || request.headers['mcp-name'] !== name) {
        writeRpc(response, 400, rpcError(requestMessage.id ?? null, -32020, 'Mcp-Name header mismatch'), limits.maxResponseBytes)
        return
      }
      toolCatalog = await safeReadToolCatalog(options, requestSignal, limits.maxWaitMs)
      const schema = toolCatalog.find((tool) => tool.name === name)?.inputSchema
      if (schema === undefined || !validateArguments(schema, asRecord(requestMessage.params)?.arguments ?? {})) {
        writeRpc(response, 200, rpcError(requestMessage.id ?? null, -32602, 'Invalid params'), limits.maxResponseBytes)
        return
      }
    }
    if (requestMessage.method === 'server/discover' && !isEmptyObjectExceptMeta(requestMessage.params)) {
      writeRpc(response, 200, rpcError(requestMessage.id ?? null, -32602, 'Invalid params'), limits.maxResponseBytes)
      return
    }
  } else if (request.headers['mcp-protocol-version'] !== undefined && !SUPPORTED_LEGACY_PROTOCOL_VERSIONS.has(String(request.headers['mcp-protocol-version']))) {
    writeRpc(response, 400, {
      ...rpcError(requestMessage.id ?? null, -32022, 'Unsupported protocol version'),
      error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested: String(request.headers['mcp-protocol-version']) } },
    }, limits.maxResponseBytes)
    return
  }
  if (requestMessage.id === undefined) {
    if (isModernRequest(requestMessage) || requestMessage.method !== 'notifications/initialized') {
      writeRpc(response, 400, rpcError(null, -32600, 'Invalid Request'), limits.maxResponseBytes)
      return
    }
    response.statusCode = 202
    response.end()
    return
  }

  const id = requestMessage.id
  try {
    const result = await dispatch(requestMessage, options, limits, getActiveCalls, adjustActiveCalls, requestSignal, modernRequest, protocolVersion, toolCatalog)
    writeRpc(response, 200, { jsonrpc: '2.0', id, result: result === undefined ? null : result }, limits.maxResponseBytes)
  } catch (error) {
    if (error instanceof DispatchLimitError) {
      writeRpc(response, 503, rpcError(id, -32000, 'Tool call capacity exceeded'), limits.maxResponseBytes)
    } else if (error instanceof DispatchTimeoutError) {
      writeRpc(response, 200, rpcError(id, -32001, 'Request timed out'), limits.maxResponseBytes)
    } else if (error instanceof MethodNotFoundError) {
      writeRpc(response, isModernRequest(requestMessage) ? 404 : 200, rpcError(id, -32601, 'Method not found'), limits.maxResponseBytes)
    } else if (error instanceof UnsupportedProtocolVersionError) {
      writeRpc(response, 400, {
        ...rpcError(id, -32022, 'Unsupported protocol version'),
        error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested: error.requested } },
      }, limits.maxResponseBytes)
    } else if (error instanceof InvalidParamsError) {
      writeRpc(response, 200, rpcError(id, -32602, 'Invalid params'), limits.maxResponseBytes)
    } else if (requestSignal.aborted || error instanceof DispatchRevokedError) {
      writeRpc(response, 503, rpcError(id, -32000, 'Transport revoked'), limits.maxResponseBytes)
    } else {
      writeRpc(response, 200, rpcError(id, -32603, 'Internal error'), limits.maxResponseBytes)
    }
  }
}

async function dispatch(
  request: JsonRpcRequest,
  options: WorkspaceMcpTransportOptions,
  limits: { readonly maxResponseBytes: number; readonly maxConcurrentCalls: number; readonly maxWaitMs: number },
  getActiveCalls: () => number,
  adjustActiveCalls: (delta: number) => void,
  lifetime: AbortSignal,
  modernRequest: boolean,
  protocolVersion: string,
  validatedCatalog?: readonly WorkspaceMcpTool[],
): Promise<unknown> {
  switch (request.method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, resources: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': options.serverInfo ?? { name: 'codingns-workspace-mcp', version: '0.1.0' } },
      }
    case 'initialize': {
      if (request.params !== undefined && !isRecord(request.params)) throw new InvalidParamsError()
      const params = asRecord(request.params)
      const requestedVersion = params?.protocolVersion
      if (requestedVersion !== undefined && (typeof requestedVersion !== 'string' || !SUPPORTED_LEGACY_PROTOCOL_VERSIONS.has(requestedVersion))) {
        throw new UnsupportedProtocolVersionError(requestedVersion)
      }
      const protocolVersion = typeof requestedVersion === 'string' ? requestedVersion : DEFAULT_PROTOCOL_VERSION
      return {
        protocolVersion: requestedVersion === undefined ? DEFAULT_PROTOCOL_VERSION : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: options.serverInfo ?? { name: 'codingns-workspace-mcp', version: '0.1.0' },
      }
    }
    case 'notifications/initialized':
      throw new MethodNotFoundError()
    case 'ping':
      return {}
    case 'tools/list': {
      if (request.params !== undefined && !isRecord(request.params)) throw new InvalidParamsError()
      const result = await safeReadToolCatalog(options, lifetime, limits.maxWaitMs)
      return modernRequest && protocolVersion === MODERN_PROTOCOL_VERSION ? { resultType: 'complete', tools: result } : { tools: result }
    }
    case 'tools/call': {
      const params = asRecord(request.params)
      const name = params?.name
      const args = params?.arguments
      if (typeof name !== 'string' || name.length === 0 || (args !== undefined && !isRecord(args))) {
        throw new InvalidParamsError()
      }
      const catalog = validatedCatalog ?? await safeReadToolCatalog(options, lifetime, limits.maxWaitMs)
      const tool = catalog.find((item) => item.name === name)
      if (tool === undefined) throw new MethodNotFoundError()
      if (!validateArguments(tool.inputSchema, args ?? {})) throw new InvalidParamsError()
      if (getActiveCalls() >= limits.maxConcurrentCalls) throw new DispatchLimitError()
      adjustActiveCalls(1)
      try {
        const result = await invokeBounded((signal) => options.callTool(name, args ?? {}, signal), lifetime, limits.maxWaitMs, () => adjustActiveCalls(-1))
        return normalizeToolResult(result, modernRequest)
      } catch (error) {
        if (lifetime.aborted) throw new DispatchRevokedError()
        throw error
      }
    }
    default:
      throw new MethodNotFoundError()
  }
}

function normalizeToolResult(value: unknown, modernRequest: boolean): unknown {
  if (modernRequest) return value
  const result = asRecord(value)
  if (result === undefined || !Object.hasOwn(result, 'resultType')) return value
  const { resultType: _resultType, ...legacyResult } = result
  return legacyResult
}

class DispatchLimitError extends Error {}
class DispatchTimeoutError extends Error {}
class DispatchRevokedError extends Error {}
class MethodNotFoundError extends Error {}
class InvalidParamsError extends Error {}
class UnsupportedProtocolVersionError extends Error {
  readonly requested: unknown

  constructor(requested: unknown) {
    super('Unsupported protocol version')
    this.requested = requested
  }
}

function invokeBounded<T>(
  callback: (signal: AbortSignal) => T | Promise<T>,
  lifetime: AbortSignal,
  maxWaitMs: number,
  onSettled?: () => void,
): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([lifetime, controller.signal])
  const operation = Promise.resolve().then(() => callback(signal))
  if (onSettled !== undefined) void operation.then(onSettled, onSettled)
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort()
      reject(new DispatchTimeoutError())
    }, maxWaitMs)
    timeout.unref?.()
    const onRevoke = (): void => reject(new DispatchRevokedError())
    lifetime.addEventListener('abort', onRevoke, { once: true })
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timeout)
      lifetime.removeEventListener('abort', onRevoke)
    })
  })
}

function parseRequest(value: unknown): JsonRpcRequest | undefined {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0) return undefined
  const id = value.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return undefined
  if (typeof id === 'number' && !Number.isFinite(id)) return undefined
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  }
}

async function safeReadToolCatalog(options: WorkspaceMcpTransportOptions, lifetime: AbortSignal, maxWaitMs: number): Promise<readonly WorkspaceMcpTool[]> {
  const tools = await invokeBounded((signal) => options.listTools(signal), lifetime, maxWaitMs)
  if (!Array.isArray(tools)) throw new TypeError('Invalid tool catalog')
  return tools
}

function validateArguments(schema: unknown, value: unknown): boolean {
  const objectSchema = asRecord(schema)
  const objectValue = asRecord(value)
  if (objectSchema === undefined || objectSchema.type !== 'object' || objectValue === undefined) return false
  const properties = asRecord(objectSchema.properties) ?? {}
  const required = Array.isArray(objectSchema.required) ? objectSchema.required : []
  if (required.some((key) => typeof key !== 'string' || !Object.hasOwn(objectValue, key))) return false
  if (objectSchema.additionalProperties === false && Object.keys(objectValue).some((key) => !Object.hasOwn(properties, key))) return false
  if (typeof objectSchema.minProperties === 'number' && Object.keys(objectValue).length < objectSchema.minProperties) return false
  if (typeof objectSchema.maxProperties === 'number' && Object.keys(objectValue).length > objectSchema.maxProperties) return false
  for (const [key, item] of Object.entries(objectValue)) {
    const propertySchema = asRecord(properties[key])
    if (propertySchema === undefined || !validateSchemaValue(propertySchema, item)) return false
  }
  return true
}

function validateSchemaValue(schema: Record<string, unknown>, value: unknown): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string'
        && (typeof schema.minLength !== 'number' || value.length >= schema.minLength)
        && (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        && (typeof schema.minimum !== 'number' || value >= schema.minimum)
        && (typeof schema.maximum !== 'number' || value <= schema.maximum)
    case 'array':
      if (!Array.isArray(value) || typeof schema.items !== 'object' || schema.items === null || Array.isArray(schema.items)) return false
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
      return value.every((item) => validateSchemaValue(schema.items as Record<string, unknown>, item))
    case 'object':
      return validateArguments(schema, value)
    default:
      return false
  }
}

function isModernRequest(request: JsonRpcRequest): boolean {
  const params = asRecord(request.params)
  const meta = asRecord(params?._meta)
  return typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
}

function protocolVersionFromMeta(request: JsonRpcRequest): unknown {
  const params = asRecord(request.params)
  const meta = asRecord(params?._meta)
  return meta?.['io.modelcontextprotocol/protocolVersion']
}

function hasClientInfoMeta(request: JsonRpcRequest): boolean {
  const params = asRecord(request.params)
  const meta = asRecord(params?._meta)
  return isRecord(meta?.['io.modelcontextprotocol/clientInfo']) && isRecord(meta?.['io.modelcontextprotocol/clientCapabilities'])
}

function isEmptyObjectExceptMeta(value: unknown): boolean {
  const params = asRecord(value)
  return params !== undefined && Object.keys(params).every((key) => key === '_meta')
}

function isSafeLoopbackOrigin(value: string): boolean {
  try {
    const origin = new URL(value)
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '[::1]')
      && origin.href === `${origin.origin}/`
      && origin.pathname === '/' && origin.search === '' && origin.hash === ''
  } catch { return false }
}

function acceptsMcpResponse(value: string | undefined): boolean {
  if (value === undefined) return false
  const types = value.split(',').map((part) => part.split(';', 1)[0]?.trim().toLowerCase())
  return types.includes('application/json') && types.includes('text/event-stream')
}

function authorized(request: IncomingMessage, apiKey: string): boolean {
  const header = request.headers.authorization
  const hasBearer = typeof header === 'string' && header.startsWith('Bearer ')
  const provided = Buffer.from(hasBearer ? header.slice(7) : '', 'utf8')
  const expected = Buffer.from(apiKey, 'utf8')
  const candidate = Buffer.alloc(expected.length)
  provided.copy(candidate, 0, 0, expected.length)
  const equal = timingSafeEqual(expected, candidate)
  return hasBearer && provided.length === expected.length && equal
}

function readBody(request: IncomingMessage, response: ServerResponse, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false
    request.on('data', (chunk: Buffer) => {
      if (oversized) return
      size += chunk.length
      if (size > maxBytes) {
        oversized = true
        chunks.length = 0
        request.pause()
        request.removeAllListeners('data')
        request.resume()
        response.setHeader('connection', 'close')
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(oversized ? undefined : Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(undefined))
    request.on('aborted', () => resolve(undefined))
  })
}

function writeRpc(response: ServerResponse, status: number, message: JsonRpcResponse, maxBytes: number): void {
  writeJson(response, status, message, maxBytes, rpcError(message.id, -32603, 'Internal error'))
}

function writeJson(response: ServerResponse, status: number, value: unknown, maxBytes: number, fallback?: unknown): void {
  if (response.headersSent || response.writableEnded) return
  let body: string
  try {
    body = JSON.stringify(value)
  } catch {
    body = ''
  }
  if (body === '' || Buffer.byteLength(body, 'utf8') > maxBytes) {
    const safeFallback = fallback ?? { error: 'response too large' }
    try {
      body = JSON.stringify(safeFallback)
    } catch {
      body = ''
    }
    if (body === '' || Buffer.byteLength(body, 'utf8') > maxBytes) {
      body = '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Response too large"}}'
    }
    if (Buffer.byteLength(body, 'utf8') > maxBytes) body = '{}'
    status = 500
  }
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(body)
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(value)
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

function boundedOption(value: number | undefined, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Workspace MCP limit must be an integer from ${String(min)} to ${String(max)}`)
  }
  return value
}

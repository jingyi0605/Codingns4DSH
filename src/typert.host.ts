/*
 * dsh-codingns 自有的 Typert Host artifact。
 *
 * 这里不能重导出官方 terminal-controller 的 TYPERT：DSH loader 会校验
 * manifest.package 必须属于实际导出它的 npm 包。下面的 endpoint、wire 字段和
 * codec 与 DSH 0.1.6-alpha.2 对齐，但 package 与 invocation id 均归本包所有。
 */
import { z } from 'zod'

const sessionIdSchema = z.string()
const terminalIdSchema = z.string()
const attachmentIdSchema = z.string()
const shellSchema = z.object({
  path: z.string().readonly(),
  args: z.array(z.string()).readonly(),
  name: z.string().readonly(),
})
const terminalInfoSchema = z.object({
  id: terminalIdSchema.readonly(),
  title: z.string().readonly(),
  shell: shellSchema.readonly(),
  cwd: z.string().readonly(),
  cols: z.number().readonly(),
  rows: z.number().readonly(),
  state: z.union([z.literal('running'), z.literal('failed'), z.literal('exited')]).readonly(),
  exitCode: z.union([z.literal(null), z.number()]).readonly(),
  error: z.string().readonly().optional(),
  controllerId: attachmentIdSchema.readonly().optional(),
})
const environmentSchema = z.object({
  cwd: z.string().readonly(),
  workspaceId: z.string().readonly().optional(),
  maxInputBytes: z.number().readonly(),
  maxCols: z.number().readonly(),
  maxRows: z.number().readonly(),
  scrollback: z.number().readonly(),
})
const createRequestSchema = z.object({
  shellPath: z.string().readonly().optional(),
  id: terminalIdSchema.readonly(),
  cols: z.number().readonly(),
  rows: z.number().readonly(),
})
const terminalFrameSchema = z.union([
  z.object({
    type: z.literal('snapshot').readonly(),
    sequence: z.number().readonly(),
    screen: z.string().readonly(),
    info: terminalInfoSchema.readonly(),
  }),
  z.object({
    type: z.literal('output').readonly(),
    sequence: z.number().readonly(),
    data: z.string().readonly(),
  }),
  z.object({
    type: z.literal('state').readonly(),
    info: terminalInfoSchema.readonly(),
  }),
])

interface StrictCodec {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly create: () => z.ZodType
}

interface InvocationParameter {
  readonly name: string
  readonly wire: string
  readonly source: 'json' | 'lookup'
  readonly lookup?: string
  readonly codec: StrictCodec
}

function codec(typeSymbol: string, schema: z.ZodType): StrictCodec {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function json(name: string, wire: string, typeSymbol: string, schema: z.ZodType): InvocationParameter {
  return { name, wire, source: 'json', codec: codec(typeSymbol, schema) }
}

function agent(): InvocationParameter {
  return {
    name: 'agent',
    wire: 'agentId',
    source: 'lookup',
    lookup: 'agent',
    codec: codec('@deepseek-ai/dsh-session/types#SessionId', sessionIdSchema),
  }
}

function invocation(
  method: string,
  parameters: readonly InvocationParameter[],
  result: StrictCodec,
  options: { readonly stream?: boolean; readonly cancellable?: boolean; readonly agentScoped?: boolean } = {},
): Record<string, unknown> {
  return {
    id: `dsh-codingns#terminal/${method}`,
    service: 'terminalController',
    namespace: 'terminal',
    method,
    ...(options.stream === true ? { mode: 'stream' } : {}),
    invocation: { kind: 'direct' },
    ...(options.agentScoped === true ? { scope: { context: 'agent', wire: 'agentId' } } : {}),
    parameters,
    ...(options.cancellable === true ? { cancellation: { parameter: 'signal' } } : {}),
    result,
  }
}

const voidResult = (method: string): StrictCodec => codec(`dsh-codingns#terminal/${method}:result`, z.void())
const idParameter = (): InvocationParameter => json(
  'id',
  'id',
  'dsh-codingns/shared#WebTerminalId',
  terminalIdSchema,
)
const attachmentParameter = (): InvocationParameter => json(
  'attachmentId',
  'attachmentId',
  'dsh-codingns/shared#TerminalAttachmentId',
  attachmentIdSchema,
)

export const TYPERT = {
  package: 'dsh-codingns',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('close', [agent(), idParameter()], voidResult('close'), { agentScoped: true }),
    invocation('create', [
      agent(),
      json(
        'request',
        'request',
        'dsh-codingns/shared#CodingNsTerminalCreateRequest',
        createRequestSchema,
      ),
    ], codec('dsh-codingns/shared#CodingNsWebTerminalInfo', terminalInfoSchema), {
      agentScoped: true,
      cancellable: true,
    }),
    invocation('environment', [agent()], codec(
      'dsh-codingns/shared#CodingNsTerminalEnvironment',
      environmentSchema,
    ), { agentScoped: true, cancellable: true }),
    invocation('follow', [agent(), idParameter(), attachmentParameter()], codec(
      'dsh-codingns/shared#CodingNsTerminalFrame',
      terminalFrameSchema,
    ), { agentScoped: true, cancellable: true, stream: true }),
    invocation('list', [json(
      'sessionId',
      'sessionId',
      '@deepseek-ai/dsh-session/types#SessionId',
      sessionIdSchema,
    )], codec('dsh-codingns#terminal/list:result', z.array(terminalInfoSchema))),
    invocation('rename', [
      agent(),
      idParameter(),
      json('title', 'title', 'dsh-codingns#terminal/rename:title', z.string()),
    ], voidResult('rename'), { agentScoped: true }),
    invocation('resize', [
      agent(),
      idParameter(),
      attachmentParameter(),
      json('cols', 'cols', 'dsh-codingns#terminal/resize:cols', z.number()),
      json('rows', 'rows', 'dsh-codingns#terminal/resize:rows', z.number()),
    ], voidResult('resize'), { agentScoped: true }),
    invocation('retain', [
      json('sessionId', 'sessionId', '@deepseek-ai/dsh-session/types#SessionId', sessionIdSchema),
      idParameter(),
    ], codec(
      'dsh-codingns/shared#CodingNsTerminalRetentionFrame',
      z.object({ type: z.literal('retained').readonly() }),
    ), { cancellable: true, stream: true }),
    invocation('shells', [agent()], codec(
      'dsh-codingns#terminal/shells:result',
      z.array(shellSchema),
    ), { agentScoped: true, cancellable: true }),
    invocation('write', [
      agent(),
      idParameter(),
      attachmentParameter(),
      json('data', 'data', 'dsh-codingns#terminal/write:data', z.string()),
    ], voidResult('write'), { agentScoped: true }),
  ],
  model: {
    services: [{
      description: 'dsh-codingns Sidebar 终端 UI 使用的兼容 controller。',
      summary: 'CodingNS 终端 controller',
      tags: [],
      jsDoc: '/** dsh-codingns Sidebar 终端 UI 使用的兼容 controller。 */',
      key: 'terminalController',
      exportName: 'CodingNsTerminalController',
      members: [
        'environment', 'shells', 'list', 'create', 'retain',
        'follow', 'write', 'resize', 'rename', 'close',
      ].map((name) => ({ name, signature: `${name}(...)`, kind: 'method' })),
      types: [],
    }],
    events: [],
    objects: [],
  },
} as const

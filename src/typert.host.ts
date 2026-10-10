/*
 * codingns4dsh 自有的 Typert Host artifact。
 *
 * 这里不能重导出官方 terminal-controller 的 TYPERT：DSH loader 会校验
 * manifest.package 必须属于实际导出它的 npm 包。下面的 endpoint、wire 字段和
 * codec 与 DSH 0.1.6-alpha.2 对齐，但 package、namespace 与 invocation id 均归本包所有。
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
  state: z.union([z.literal('running'), z.literal('failed'), z.literal('exited'), z.literal('lost')]).readonly(),
  exitCode: z.union([z.literal(null), z.number()]).readonly(),
  error: z.string().readonly().optional(),
  controllerId: attachmentIdSchema.readonly().optional(),
})
const environmentSchema = z.object({
  cwd: z.string().readonly(),
  workspaceId: z.string().readonly().optional(),
  platform: z.union([z.literal('darwin'), z.literal('linux'), z.literal('win32'), z.literal('unsupported')]).readonly().optional(),
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
  /** rc3 使用 schema；alpha2 使用 create；同时保留两者以兼容两代 Loader。 */
  readonly schema: z.ZodType
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
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
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
  options: { readonly stream?: boolean; readonly cancellable?: boolean; readonly agentScoped?: boolean; readonly service?: string; readonly namespace?: string } = {},
): Record<string, unknown> {
  return {
    id: `codingns4dsh#${options.namespace ?? 'terminal'}/${method}`,
    service: options.service ?? 'terminalController',
    // DSH 0.1.7 的 api-remotes/client 会自动挂载官方 remote.terminal；
    // 使用独立命名空间才能确保终端 UI 实际调用 Codingns4DSH Host controller。
    namespace: options.namespace ?? 'codingnsTerminal',
    method,
    ...(options.stream === true ? { mode: 'stream' } : {}),
    invocation: { kind: 'direct' },
    ...(options.agentScoped === true ? { scope: { context: 'agent', wire: 'agentId' } } : {}),
    parameters,
    ...(options.cancellable === true ? { cancellation: { parameter: 'signal' } } : {}),
    result,
  }
}

const voidResult = (method: string): StrictCodec => codec(`codingns4dsh#terminal/${method}:result`, z.void())
const unknownResult = (name: string): StrictCodec => codec(`codingns4dsh#${name}:result`, z.unknown())
const idParameter = (): InvocationParameter => json(
  'id',
  'id',
  'codingns4dsh/shared#WebTerminalId',
  terminalIdSchema,
)
const attachmentParameter = (): InvocationParameter => json(
  'attachmentId',
  'attachmentId',
  'codingns4dsh/shared#TerminalAttachmentId',
  attachmentIdSchema,
)

export const TYPERT = {
  // Typert Loader 要求 manifest.package 与导出该 manifest 的 npm 包名完全一致。
  package: '@jingyi0605/codingns4dsh',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('stream', [], unknownResult('assistant-notifications/stream'), {
      service: 'assistantNotificationController',
      namespace: 'codingnsAssistantNotifications',
      cancellable: true,
      stream: true,
    }),
    invocation('sourceStream', [json('request', 'request', 'codingns4dsh#assistant-notifications/source-request', z.unknown())], unknownResult('assistant-notifications/source-stream'), {
      service: 'assistantNotificationController',
      namespace: 'codingnsAssistantNotifications',
      cancellable: true,
      stream: true,
    }),
    invocation('close', [agent(), idParameter()], voidResult('close'), { agentScoped: true }),
    invocation('create', [
      agent(),
      json(
        'request',
        'request',
        'codingns4dsh/shared#CodingNsTerminalCreateRequest',
        createRequestSchema,
      ),
    ], codec('codingns4dsh/shared#CodingNsWebTerminalInfo', terminalInfoSchema), {
      agentScoped: true,
      cancellable: true,
    }),
    invocation('environment', [agent()], codec(
      'codingns4dsh/shared#CodingNsTerminalEnvironment',
      environmentSchema,
    ), { agentScoped: true, cancellable: true }),
    invocation('follow', [agent(), idParameter(), attachmentParameter()], codec(
      'codingns4dsh/shared#CodingNsTerminalFrame',
      terminalFrameSchema,
    ), { agentScoped: true, cancellable: true, stream: true }),
    invocation('list', [json(
      'sessionId',
      'sessionId',
      '@deepseek-ai/dsh-session/types#SessionId',
      sessionIdSchema,
    )], codec('codingns4dsh#terminal/list:result', z.array(terminalInfoSchema))),
    invocation('rename', [
      agent(),
      idParameter(),
      json('title', 'title', 'codingns4dsh#terminal/rename:title', z.string()),
    ], voidResult('rename'), { agentScoped: true }),
    invocation('resize', [
      agent(),
      idParameter(),
      attachmentParameter(),
      json('cols', 'cols', 'codingns4dsh#terminal/resize:cols', z.number()),
      json('rows', 'rows', 'codingns4dsh#terminal/resize:rows', z.number()),
    ], voidResult('resize'), { agentScoped: true }),
    invocation('retain', [
      json('sessionId', 'sessionId', '@deepseek-ai/dsh-session/types#SessionId', sessionIdSchema),
      idParameter(),
    ], codec(
      'codingns4dsh/shared#CodingNsTerminalRetentionFrame',
      z.object({ type: z.literal('retained').readonly() }),
    ), { cancellable: true, stream: true }),
    invocation('shells', [agent()], codec(
      'codingns4dsh#terminal/shells:result',
      z.array(shellSchema),
    ), { agentScoped: true, cancellable: true }),
    invocation('write', [
      agent(),
      idParameter(),
      attachmentParameter(),
      json('data', 'data', 'codingns4dsh#terminal/write:data', z.string()),
    ], voidResult('write'), { agentScoped: true }),
  ],
  model: {
    services: [{
      description: 'codingns4dsh Sidebar 终端 UI 使用的兼容 controller。',
      summary: 'Codingns4DSH 终端 controller',
      tags: [],
      jsDoc: '/** codingns4dsh Sidebar 终端 UI 使用的兼容 controller。 */',
      key: 'terminalController',
      exportName: 'CodingNsTerminalController',
      members: [
        'environment', 'shells', 'list', 'create', 'retain',
        'follow', 'write', 'resize', 'rename', 'close',
      ].map((name) => ({ name, signature: `${name}(...)`, kind: 'method' })),
      types: [],
    }, {
      description: 'codingns4dsh 全局助理通知事件流。',
      summary: 'Codingns4DSH 通知 controller',
      tags: [],
      jsDoc: '/** 全局助理通知的快照与 revision 增量流。 */',
      key: 'assistantNotificationController',
      exportName: 'AssistantNotificationController',
      members: [
        { name: 'stream', signature: 'stream(...)', kind: 'method' },
        { name: 'sourceStream', signature: 'sourceStream(...)', kind: 'method' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
} as const

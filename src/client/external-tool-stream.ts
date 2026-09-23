import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { ConversationNodeDefinition, ConversationLocation, ConversationMatch, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CodingNsClientServices } from './features/types.js'
import { dshThemeColor } from './theme.js'

/** 浏览器收到的 Host 外部工具临时标记。 */
interface ExternalToolMarker {
  readonly source: 'codingns-external-tool'
  readonly phase: 'start' | 'update'
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output?: string
  readonly error?: string
}

export interface CodingNsExternalToolChatData {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: ExternalToolMarker['status']
  readonly output?: string
  readonly error?: string
}

interface ExternalToolState {
  readonly marker: ExternalToolMarker
}

/**
 * 把实时 assistant/live-chunk 工具标记投影成 Chat 节点。
 * assistant/attempt 读取仅为兼容已经存在的旧历史；新 Host 的持久时间线使用原生
 * tool/call 与 tool/result，避免把工具事件误当成模型结算。
 */
const externalToolDefinition: ConversationNodeDefinition<ExternalToolState> = {
  kind: 'codingns-external-tool',
  target: 'chat',
  match(event: unknown) {
    const marker = readMarker(event)
    return marker === null ? null : { id: marker.callId, role: marker.phase === 'start' ? 'start' : 'update' }
  },
  start(_context: unknown, match: ConversationStartMatch) {
    const marker = readMarker(match.event)
    if (marker === null) throw new Error('外部工具节点缺少起始标记')
    return { marker }
  },
  update(context: { readonly state: ExternalToolState }, match: ConversationMatch) {
    const marker = readMarker(match.event)
    return marker === null ? context.state : { marker }
  },
  buildViewNode(context) {
    const state = context.state
    if (state === undefined) return null
    const location: ConversationLocation = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: 'codingns-external-tool',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location,
      visibility: 'visible',
      data: state.marker,
    }
  },
}

interface ExternalToolNodeProps {
  readonly node: { readonly data: CodingNsExternalToolChatData }
}

/** 外部工具临时节点的紧凑渲染；持久化后由 DSH 原生工具节点接管。 */
function ExternalToolNodeView(props: ExternalToolNodeProps): ReactElement {
  const data = props.node.data
  const statusLabel = data.status === 'failed' ? '失败' : data.status === 'completed' ? '已完成' : '运行中'
  const output = data.error ?? data.output
  return createElement('div', {
    style: {
      alignSelf: 'stretch',
      margin: '4px 0',
      padding: '8px 10px',
      border: `1px solid ${data.status === 'failed' ? dshThemeColor.error : dshThemeColor.border}`,
      borderRadius: 6,
      color: dshThemeColor.labelPrimary,
      background: dshThemeColor.inputBackground,
      fontSize: 13,
      lineHeight: 1.45,
    },
    'data-codingns-external-tool': data.callId,
  },
  createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 600 } },
    createElement('span', undefined, data.name),
    createElement('span', { style: { color: data.status === 'failed' ? dshThemeColor.error : dshThemeColor.labelTertiary, fontWeight: 400 } }, statusLabel),
  ),
  createElement('pre', { style: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--dsw-font-family-mono, monospace)', color: dshThemeColor.labelSecondary } }, data.arguments),
  output === undefined || output === '' ? null : createElement('pre', { style: { margin: '6px 0 0', maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--dsw-font-family-mono, monospace)', color: data.status === 'failed' ? dshThemeColor.error : dshThemeColor.labelSecondary } }, output),
  )
}

/** 启用外部 Agent 时安装实时工具节点；模块停用时同时撤销 Definition 和 Renderer。 */
export function registerExternalToolStreamUi(services: CodingNsClientServices): () => void {
  const uiConversation = services.uiConversation as { events?: { register(definition: ConversationNodeDefinition): () => void } } | undefined
  const slots = services.slots
  if (uiConversation?.events?.register === undefined || slots === undefined) return () => undefined
  const removeDefinition = uiConversation.events.register(externalToolDefinition)
  const slotRegistry = slots as unknown as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: (props: ExternalToolNodeProps) => ReactElement): () => void
  }
  const removeRenderer = slotRegistry.inject('conversation.chat.node', () => slotRegistry.register({
    name: 'conversation.chat.node',
    key: 'codingns-external-tool',
  }, ExternalToolNodeView))
  return () => {
    removeRenderer()
    removeDefinition()
  }
}

function readMarker(event: unknown): ExternalToolMarker | null {
  if (!isRecord(event)) return null
  const data = event.data
  if (!isRecord(data)) return null
  const candidate = event.type === 'assistant/live-chunk'
    ? isRecord(data.chunk) ? data.chunk.codingnsExternalTool : undefined
    : event.type === 'assistant/attempt'
      ? data.codingnsExternalTool
      : undefined
  if (!isRecord(candidate) || candidate.source !== 'codingns-external-tool') return null
  if (typeof candidate.callId !== 'string' || candidate.callId === '') return null
  if (typeof candidate.name !== 'string' || typeof candidate.arguments !== 'string') return null
  if (candidate.phase !== 'start' && candidate.phase !== 'update') return null
  if (candidate.status !== 'running' && candidate.status !== 'completed' && candidate.status !== 'failed') return null
  return {
    source: 'codingns-external-tool',
    phase: candidate.phase,
    callId: candidate.callId,
    name: candidate.name,
    arguments: candidate.arguments,
    status: candidate.status,
    ...(typeof candidate.output === 'string' ? { output: candidate.output } : {}),
    ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

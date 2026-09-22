import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, enrichEfforts, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'

export class ClaudeCodeDriver extends StandardStreamDriver {
  private readonly sessionRoots: readonly string[]

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
  }
  async listModels() {
    if (!(await this.detect()).installed) return emptyCatalog()
    const catalog = await super.listModels()
    return catalog.groups.length > 0 ? enrichEfforts(catalog, CLAUDE_CATALOG) : CLAUDE_CATALOG
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }
  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }
  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const event = value.type === 'stream_event' && typeof value.event === 'object' && value.event !== null ? value.event as Record<string, unknown> : value
    const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta as Record<string, unknown> : null
    if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text-delta', text: delta.text }]
    if (event.type === 'content_block_start' && isToolRecord(event.content_block) && event.content_block.type === 'tool_use') {
      const tool = claudeToolUse(event.content_block)
      return tool === null ? [] : [tool]
    }
    if ((value.type === 'assistant' || value.type === 'user') && typeof value.message === 'object' && value.message !== null) {
      const message = value.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      return content.flatMap((part): CodingNsAgentEvent[] => {
        if (!part || typeof part !== 'object') return []
        const item = part as Record<string, unknown>
        if (item.type === 'tool_use') {
          const tool = claudeToolUse(item)
          return tool === null ? [] : [tool]
        }
        if (item.type === 'tool_result') {
          const tool = claudeToolResult(item)
          return tool === null ? [] : [tool]
        }
        return typeof item.text === 'string' ? [{ type: 'text-delta', text: item.text }] : []
      })
    }
    return super.parseEvent(value, input)
  }
}

function claudeToolUse(item: Record<string, unknown>): CodingNsAgentEvent | null {
  const toolName = firstToolText(item.name, item.toolName)
  if (toolName === undefined) return null
  const callId = firstToolText(item.id, item.tool_use_id, item.toolUseId)
  const input = serializeToolValue(item.input ?? item.arguments)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName,
    status: 'running',
    ...(callId ? { callId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

function claudeToolResult(item: Record<string, unknown>): CodingNsAgentEvent | null {
  const callId = firstToolText(item.tool_use_id, item.toolUseId, item.callId)
  if (callId === undefined) return null
  const failed = item.is_error === true || item.isError === true
  const content = serializeToolValue(item.content ?? item.output ?? item.result)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName: firstToolText(item.name, item.toolName) ?? 'tool',
    callId,
    status: failed ? 'failed' : 'completed',
    ...(failed ? (content === undefined ? {} : { error: content }) : (content === undefined ? {} : { output: content })),
    ...(!failed && content !== undefined ? { outputMode: 'snapshot' as const } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** 简短别名，便于按适配器名称装配。 */
export { ClaudeCodeDriver as ClaudeDriver }

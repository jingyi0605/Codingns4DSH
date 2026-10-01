import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { discoverClaudeModelCatalog } from './claude-model-options.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { claudeBridgeArgs } from '../cli-bridge/injections.js'

export class ClaudeCodeDriver extends StandardStreamDriver {
  private readonly sessionRoots: readonly string[]
  private readonly claudeConfigDir: string | undefined
  private readonly discoveryFetch: typeof fetch | undefined

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
    this.claudeConfigDir = options.claudeConfigDir
    this.discoveryFetch = options.fetch
  }
  async listModels() {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    try {
      return await discoverClaudeModelCatalog({
        command: detected.command,
        spawn: this.runSpawn,
        ...(this.discoveryFetch ? { fetch: this.discoveryFetch } : {}),
        ...(this.claudeConfigDir ? { configDir: this.claudeConfigDir } : {}),
      })
    } catch {
      return CLAUDE_CATALOG
    }
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }
  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', promptWithAttachmentPaths(input.prompt, input.attachments ?? []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    // 子代理托管开启时注入 MCP 替身工具并停用内建 Task 子代理。
    args.push(...claudeBridgeArgs(input.sessionId, this.descriptor.id))
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
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

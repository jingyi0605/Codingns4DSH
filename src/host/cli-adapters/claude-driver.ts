import type { CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, enrichEfforts, isProviderDefaultModel } from './model-catalog.js'

export class ClaudeCodeDriver extends StandardStreamDriver {
  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] }, { binaries: ['claude'] }, options)
  }
  async listModels() {
    if (!(await this.detect()).installed) return emptyCatalog()
    const catalog = await super.listModels()
    return catalog.groups.length > 0 ? enrichEfforts(catalog, CLAUDE_CATALOG) : CLAUDE_CATALOG
  }
  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }
  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsCliStreamChunk[] {
    const event = value.type === 'stream_event' && typeof value.event === 'object' && value.event !== null ? value.event as Record<string, unknown> : value
    const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta as Record<string, unknown> : null
    if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text-delta', text: delta.text }]
    if (value.type === 'assistant' && typeof value.message === 'object' && value.message !== null) {
      const message = value.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      return content.flatMap((part): CodingNsCliStreamChunk[] => {
        if (!part || typeof part !== 'object') return []
        const item = part as Record<string, unknown>
        return typeof item.text === 'string' ? [{ type: 'text-delta', text: item.text }] : []
      })
    }
    return super.parseEvent(value, input)
  }
}

/** 简短别名，便于按适配器名称装配。 */
export { ClaudeCodeDriver as ClaudeDriver }

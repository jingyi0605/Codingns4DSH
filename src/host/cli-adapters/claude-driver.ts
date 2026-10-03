import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, clearEfforts, isProviderDefaultModel } from './model-catalog.js'
import { discoverClaudeModelCatalog } from './claude-model-options.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { WINDOWS, commandEnvironment } from './process-utils.js'
import { claudeBridgeArgs } from '../cli-bridge/injections.js'

export class ClaudeCodeDriver extends StandardStreamDriver {
  private readonly sessionRoots: readonly string[]
  private readonly claudeConfigDir: string | undefined
  private readonly discoveryFetch: typeof fetch | undefined
  /**
   * `--effort` 探测结论，绑定到具体的 CLI 路径与版本。
   *
   * 只缓存确定结论：探测本身失败（进程无法启动、读不到帮助文本）时保持未缓存，
   * 下一轮重试。否则一次偶发失败会把强度切换永久关掉，且无法自愈。
   */
  private effortProbe: { readonly command: string; readonly version: string | null; readonly supported: boolean } | undefined
  /** 最近一次 detect 得到的版本；CLI 原地升级后据此让探测缓存失效。 */
  private detectedVersion: string | null = null

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
    this.claudeConfigDir = options.claudeConfigDir
    this.discoveryFetch = options.fetch
  }
  /** 每次探测都记录版本，让 `--effort` 缓存能随 CLI 原地升级失效。 */
  override async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const detected = await super.detect()
    this.detectedVersion = detected.version
    return detected
  }

  async listModels() {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    let catalog: CodingNsCliModelCatalog
    try {
      catalog = await discoverClaudeModelCatalog({
        command: detected.command,
        spawn: this.runSpawn,
        ...(this.discoveryFetch ? { fetch: this.discoveryFetch } : {}),
        ...(this.claudeConfigDir ? { configDir: this.claudeConfigDir } : {}),
      })
    } catch {
      catalog = CLAUDE_CATALOG
    }
    // CLI 明确不支持 `--effort` 时，驱动不会下发该参数；此时目录也不能展示档位，
    // 否则用户看到的是一个切换后不生效的选项。探测不确定时保持目录原样。
    return this.probeEffortSupport() === 'unsupported' ? clearEfforts(catalog) : catalog
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }
  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', promptWithAttachmentPaths(input.prompt, input.attachments ?? []), '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', 'bypassPermissions']
    // 子代理托管开启时注入 MCP 替身工具并停用内建 Task 子代理。
    args.push(...claudeBridgeArgs(input.sessionId, this.descriptor.id))
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    // `--effort` 是 CLI 的会话级参数，会写进请求的 output_config.effort；
    // 只有探测到当前 CLI 支持该参数时才下发，避免旧版本因未知参数直接失败。
    const effort = input.effortId?.trim()
    if (effort && effort !== 'default' && this.supportsEffortOption()) args.push('--effort', effort)
    return args
  }

  /**
   * 探测 `claude` 对 `--effort` 的支持状态。
   *
   * 只在拿到确定结论时缓存，并按「CLI 路径 + 版本」作键：路径相同但版本变了
   * （原地升级）会重新探测。探测失败时返回 unknown 且不缓存，让下一轮重试——
   * 既不会把偶发失败固化成「不支持」，也不会冒险给旧 CLI 传未知选项。
   */
  private probeEffortSupport(): 'supported' | 'unsupported' | 'unknown' {
    const command = this.resolvedBinary
    if (command === null) return 'unknown'
    const cached = this.effortProbe
    if (cached !== undefined && cached.command === command && cached.version === this.detectedVersion) {
      return cached.supported ? 'supported' : 'unsupported'
    }
    try {
      const result = this.runSpawnSync(command, ['--help'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS, env: commandEnvironment(command),
      })
      const help = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
      // 只有真正读到帮助文本才算拿到结论。退出码非零或输出为空时，既可能是
      // 旧 CLI 没有该参数，也可能是本次调用环境异常；一律按 unknown 处理，
      // 不缓存、也不据此清空目录，避免把偶发失败固化成「不支持」。
      if (result.status !== 0 || help.trim() === '') return 'unknown'
      const supported = /--effort\b/u.test(help)
      this.effortProbe = { command, version: this.detectedVersion, supported }
      return supported ? 'supported' : 'unsupported'
    } catch {
      return 'unknown'
    }
  }

  /** 只有确认支持时才下发 `--effort`；旧版本遇到未知选项会整轮失败。 */
  private supportsEffortOption(): boolean {
    return this.probeEffortSupport() === 'supported'
  }

  override dispose(): void {
    this.effortProbe = undefined
    this.detectedVersion = null
    super.dispose()
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

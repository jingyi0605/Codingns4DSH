import { fileURLToPath } from 'node:url'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import { getSubagentBridge } from './bridge-holder.js'

/**
 * 注入构造器：把桥接端点、令牌与会话身份翻译成各外部 CLI 的原生扩展面。
 *
 * 桥接父会话和桥接创建出的子会话都注入 DSH 派发端点。子会话通过环境标记
 * 禁止再次 start，仍保留 send 回传父会话的能力，避免把结果困在子会话里。
 */

const MCP_ENTRY_PATH = fileURLToPath(new URL('./mcp-stdio-entry.js', import.meta.url))
const COMMAND_CODE_MOD_PATH = fileURLToPath(new URL('./command-code-mod.js', import.meta.url))

/** 外部 CLI 侧认为这是一次由 Codingns4DSH 托管的会话。 */
const BRIDGE_MARKER = 'CODINGNS_SUBAGENT_BRIDGE'
const NATIVE_AGENT_BLOCK_MARKER = 'CODINGNS_DISABLE_NATIVE_AGENT'
const SUBAGENT_CHILD_MARKER = 'CODINGNS_SUBAGENT_CHILD'
/**
 * Claude Code 的内建子代理工具曾叫 `Task`，当前版本公开名称是 `Agent`。
 * CLI 会把 `Task` 作为兼容别名改写，但同时传入两个名称可以覆盖旧版、当前版
 * 以及用户自定义工具映射，避免原生入口绕过 CodingNS 桥接。
 */
const CLAUDE_NATIVE_SUBAGENT_BLOCK_ARGS = ['--disallowedTools', 'Task', 'Agent'] as const

export function bridgeMcpEntryPath(): string {
  return MCP_ENTRY_PATH
}

export function bridgeCommandCodeModPath(): string {
  return COMMAND_CODE_MOD_PATH
}

/** 桥接是否应当介入该会话；子会话也需要桥接来回传父会话报告。 */
export function subagentBridgeActive(sessionId: string): boolean {
  return getSubagentBridge() !== undefined && sessionId.trim() !== ''
}

/** command-code：`--mod` 每次运行加载托管 mod。 */
export function commandCodeBridgeArgs(sessionId: string): readonly string[] {
  if (!subagentBridgeActive(sessionId)) return []
  return ['--mod', COMMAND_CODE_MOD_PATH]
}

/**
 * command-code：每次启动都加载屏蔽原生 agent 的 Mod。
 *
 * 这里不能再以桥接服务是否已启动作为条件。桥接启动失败时如果不加载 Mod，
 * Command Code 会静默回退到自己的 agent 工具，正是本次问题的根因。Mod 会在
 * 桥接可用时派发到 DSH；桥接不可用时明确阻断调用并返回诊断。
 */
export function commandCodeNativeAgentArgs(_sessionId: string): readonly string[] {
  return ['--mod', COMMAND_CODE_MOD_PATH]
}

/** command-code：mod 从进程环境读取桥接配置。 */
export function commandCodeBridgeEnvironment(sessionId: string, adapterId: string): Record<string, string> {
  return bridgeEnvironment(sessionId, adapterId) ?? {}
}

/**
 * command-code：所有会话都注入屏蔽标记；父、子会话都拿到派发端点，子会话
 * 额外携带防递归标记。这样即使设置关闭或桥接启动失败，也绝不会暴露原生 agent。
 */
export function commandCodeNativeAgentEnvironment(sessionId: string, adapterId: string): Record<string, string> {
  const child = isSubagentChildSession(sessionId)
  return {
    [NATIVE_AGENT_BLOCK_MARKER]: '1',
    ...(child ? { [SUBAGENT_CHILD_MARKER]: '1' } : {}),
    ...(bridgeEnvironment(sessionId, adapterId) ?? {}),
  }
}

/** claude-code：`--mcp-config` 注入替身工具，并停用内建 Task/Agent。 */
export function claudeBridgeArgs(sessionId: string, adapterId: string): readonly string[] {
  const env = bridgeEnvironment(sessionId, adapterId)
  // CodingNS 创建的 Claude 子会话不能再次托管子代理，否则会形成没有父级
  // 生命周期记录的递归树。子会话仍然启动普通 Claude 工具，但明确屏蔽内建
  // Agent/Task；同时保留 DSH MCP 派发工具，让它能把报告送回父会话。
  if (env === undefined) return isSubagentChildSession(sessionId) ? CLAUDE_NATIVE_SUBAGENT_BLOCK_ARGS : []
  const config = JSON.stringify({ mcpServers: { codingns: mcpServerConfig(env) } })
  return [
    '--mcp-config', config,
    '--append-system-prompt', bridgeSubagentGuidance('mcp__codingns__agent_subagent'),
    ...CLAUDE_NATIVE_SUBAGENT_BLOCK_ARGS,
  ]
}

/**
 * codex：`thread/start`、`thread/resume` 的 developerInstructions 是线程级指令面；
 * Codex 不会自发使用注入的 MCP 工具，必须显式告诉它何时改走 DSH 子代理会话。
 */
export function codexBridgeDeveloperInstructions(sessionId: string): string | undefined {
  if (!subagentBridgeActive(sessionId)) return undefined
  return bridgeSubagentGuidance('codingns.agent_subagent')
}

/**
 * ACP 适配器（含 command-code/gemini/grok/mcode）：session/new 与 session/load
 * 都带上 MCP server。Command Code 自己另有 Mod 注入，用于屏蔽原生 agent。
 */
export function acpBridgeMcpServers(sessionId: string, adapterId: string): readonly Record<string, unknown>[] {
  const env = bridgeEnvironment(sessionId, adapterId)
  if (env === undefined) return []
  return [{
    name: 'codingns',
    command: process.execPath,
    args: [MCP_ENTRY_PATH],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  }]
}

/**
 * OpenCode V2：运行时 MCP 注册所需的本地 server 配置。
 *
 * OpenCode V2 不读取 ACP 的 session/new 扩展字段，必须通过
 * `/api/experimental/mcp/:server` 注册本地 MCP。配置只在内存中生成，凭据仍由
 * 当前 Host 进程环境注入，不写入 OpenCode 配置文件。
 */
export function openCodeBridgeMcpConfig(sessionId: string, adapterId: string): {
  /** OpenCode V2 的 MCP 配置按 server name 全局覆盖；名称必须按 DSH 会话隔离。 */
  readonly serverName: string
  readonly toolName: string
  readonly config: {
    readonly type: 'local'
    readonly command: readonly string[]
    readonly environment: Readonly<Record<string, string>>
    readonly timeout: {
      readonly execution: number
    }
  }
} | undefined {
  const env = bridgeEnvironment(sessionId, adapterId)
  if (env === undefined) return undefined
  const serverName = openCodeBridgeServerName(sessionId)
  return {
    serverName,
    toolName: `${serverName}_${isSubagentChildSession(sessionId) ? 'send_message' : 'agent_subagent'}`,
    config: {
      type: 'local',
      command: [process.execPath, MCP_ENTRY_PATH],
      environment: env,
      // read/wait 可能等待 DSH 子会话完成；不能沿用 OpenCode 的短 MCP 默认超时。
      timeout: { execution: 260_000 },
    },
  }
}

/** codex：`-c` 每次启动覆盖配置，注入 MCP server。 */
export function codexBridgeArgs(sessionId: string, adapterId: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  const env = bridgeEnvironment(sessionId, adapterId)
  if (env === undefined) return []
  const envToml = `{${Object.entries(env).map(([key, value]) => `${key}=${tomlString(value, platform)}`).join(',')}}`
  return [
    '-c', codexConfigOverride('mcp_servers.codingns.command', tomlString(process.execPath, platform)),
    '-c', codexConfigOverride('mcp_servers.codingns.args', `[${tomlString(MCP_ENTRY_PATH, platform)}]`),
    '-c', codexConfigOverride('mcp_servers.codingns.env', envToml),
    // Codex 对 MCP 工具调用强制审批：approvalPolicy=never 的会话会直接失败
    // （"MCP tool call requires approval, but approval policy is never"）。
    // 托管工具属于基础设施级委派，固定为自动批准，避免把 DSH 权限模型外包给 Codex。
    '-c', codexConfigOverride('mcp_servers.codingns.default_tools_approval_mode', tomlString('approve', platform)),
  ]
}

function bridgeEnvironment(sessionId: string, adapterId: string): Record<string, string> | undefined {
  const runtime = getSubagentBridge()
  if (runtime === undefined || sessionId.trim() === '') return undefined
  const child = isSubagentChildSession(sessionId)
  return {
    [BRIDGE_MARKER]: '1',
    CODINGNS_BRIDGE_URL: runtime.baseUrl,
    CODINGNS_BRIDGE_TOKEN: runtime.token,
    CODINGNS_DSH_SESSION_ID: sessionId,
    CODINGNS_ADAPTER_ID: adapterId,
    ...(child ? { [SUBAGENT_CHILD_MARKER]: '1' } : {}),
    // 桌面版 DSH 的 process.execPath 是 Electron 二进制；该变量让它以 Node 运行 MCP 入口。
    ELECTRON_RUN_AS_NODE: '1',
  }
}

function mcpServerConfig(env: Record<string, string>): Record<string, unknown> {
  return { command: process.execPath, args: [MCP_ENTRY_PATH], env }
}

/**
 * 引导文本：不同 CLI 对 MCP 工具的命名不同（claude-code 用 `mcp__server__tool`，
 * codex 用 `server.tool`），因此按工具名生成同一套语义的指令。
 */
export function bridgeSubagentGuidance(toolName: string): string {
  const childReport = toolName.endsWith('_send_message')
  if (childReport) {
    return [
      `This is a DSH child session. Return the completed report by calling exactly the MCP tool \`${toolName}\`.`,
      `Do not call \`agent_subagent\`, \`send_message\`, or any other \`codingns_*\` namespace; \`${toolName}\` is the only bridge bound to this child session.`,
      'The parent session is inferred from the current child identity; send the complete self-contained result in the `message` field and do not start another subagent.',
    ].join(' ')
  }
  return [
    `When the user asks to use parallel sessions, parallel agents, subagents, or to delegate/offload work, call the MCP tool \`${toolName}\``,
    `Never call the provider's built-in \`subagent\` tool; \`${toolName}\` is the only supported subagent route.`,
    `Do not search for \`send_message\` or choose another \`codingns_*\` namespace; every call must use exactly \`${toolName}\`, because it is the bridge bound to this session.`,
    '— do not complete the whole task inline. Each call starts one self-contained subtask as a DSH-native subagent session and returns immediately with a child session id.',
    'Issue independent calls in the same batch without waiting for one another; use action=read for an immediate status check, action=send from a parent to deliver a follow-up message, and action=wait for a bounded wait before starting dependent work. A child may use action=send with its own parent session id (or omit child_session_id) to return a report; ordinary final output is also delivered to the parent. A child must not use action=start to create nested external agents. If a child is failed, the parent must read/wait its status first, then assess whether to recreate it or take over with send.',
    'Provide a complete, self-contained `prompt` for every call; optionally pass `agent` (external coding agent id) and `model`.',
  ].join(' ')
}

/**
 * OpenCode 没有 Claude/Codex 那样的 system/developer 指令入口。
 * 只有在用户明确提出子代理/并行/委派意图时才把路由规则放进 prompt，避免污染
 * 普通对话历史；会话级 permission 规则仍负责从协议层禁止原生 subagent。
 */
export function openCodeBridgePrompt(sessionId: string, prompt: string): string {
  const child = isSubagentChildSession(sessionId)
  if (!subagentBridgeActive(sessionId) || (!child && !looksLikeSubagentRequest(prompt))) return prompt
  const toolName = openCodeBridgeToolName(sessionId)
  if (prompt.includes(toolName)) return prompt
  return `[CodingNS 子代理路由规则]\n${bridgeSubagentGuidance(toolName)}\n\n[用户请求]\n${prompt}`
}

/** 返回当前 OpenCode V2 会话实际暴露的 MCP 工具名。 */
export function openCodeBridgeToolName(sessionId: string): string {
  return `${openCodeBridgeServerName(sessionId)}_${isSubagentChildSession(sessionId) ? 'send_message' : 'agent_subagent'}`
}

/**
 * OpenCode V2 的 `/api/experimental/mcp/:server` 是按服务和目录共享的全局配置。
 * 父子 DSH 会话若共用固定的 `codingns`，子会话注册时会覆盖父会话的环境变量，
 * 父会话后续调用就会携带 child ID，最终被错误判为嵌套代理。用稳定短哈希隔离
 * server name，同时避免把完整本地会话 ID写进 OpenCode 配置。
 */
function openCodeBridgeServerName(sessionId: string): string {
  let hash = 2166136261
  for (const char of sessionId.trim()) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `codingns_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function looksLikeSubagentRequest(prompt: string): boolean {
  return /(?:并行|子代理|子\s*Agent|subagent|delegate|delegat(?:e|ion)|委派|agent\s*team|parallel\s+(?:agent|session))/iu.test(prompt)
}

function isSubagentChildSession(sessionId: string): boolean {
  if (sessionId === '') return false
  try {
    const registry = getAdapterRegistry()
    const nativeHeader = asRecord(asRecord(registry?.nativeSession(sessionId))?.header)
    if (nativeHeader !== undefined) {
      const parentSessionId = typeof nativeHeader.parentSession === 'string' ? nativeHeader.parentSession.trim() : ''
      return nativeHeader.origin === 'subagent' && parentSessionId !== '' && parentSessionId !== sessionId
    }
    const record = registry?.sessionRecords?.get(sessionId)
    const parentSessionId = record?.parentSessionId?.trim() ?? ''
    // origin 单独存在不足以证明这是 child：旧索引在父会话绑定被复用时可能
    // 残留 origin。必须同时有一个非空且不同于自身的直属父会话。
    return record?.origin === 'subagent' && parentSessionId !== '' && parentSessionId !== sessionId
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

/** 构造 Codex 的 `key=value` argv；Windows 的 shell 转义由进程层统一处理。 */
export function codexConfigOverride(key: string, value: string): string {
  return `${key}=${value}`
}

/**
 * TOML 字符串。Windows 优先使用字面量字符串，避免 JSON 双引号在 cmd.exe
 * 的二次解析中丢失；极少数包含单引号的路径退回基本字符串，由外层 argv
 * 引号保护处理。
 */
function tomlString(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && !value.includes("'")) return `'${value}'`
  return JSON.stringify(value)
}

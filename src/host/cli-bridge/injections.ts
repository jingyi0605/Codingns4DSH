import { fileURLToPath } from 'node:url'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import { getSubagentBridge } from './bridge-holder.js'

/**
 * 注入构造器：把桥接端点、令牌与会话身份翻译成各外部 CLI 的原生扩展面。
 *
 * 所有注入都只在桥接开启、且目标会话不是子代理会话时生效。子代理会话运行
 * 同一个外部 Agent 时不再注入，避免嵌套托管无限递归。
 */

const MCP_ENTRY_PATH = fileURLToPath(new URL('./mcp-stdio-entry.js', import.meta.url))
const COMMAND_CODE_MOD_PATH = fileURLToPath(new URL('./command-code-mod.js', import.meta.url))

/** 外部 CLI 侧认为这是一次由 Codingns4DSH 托管的会话。 */
const BRIDGE_MARKER = 'CODINGNS_SUBAGENT_BRIDGE'

export function bridgeMcpEntryPath(): string {
  return MCP_ENTRY_PATH
}

export function bridgeCommandCodeModPath(): string {
  return COMMAND_CODE_MOD_PATH
}

/** 桥接是否应当介入该会话；子代理会话一律排除。 */
export function subagentBridgeActive(sessionId: string): boolean {
  if (getSubagentBridge() === undefined) return false
  return !isSubagentChildSession(sessionId)
}

/** command-code：`--mod` 每次运行加载托管 mod。 */
export function commandCodeBridgeArgs(sessionId: string): readonly string[] {
  if (!subagentBridgeActive(sessionId)) return []
  return ['--mod', COMMAND_CODE_MOD_PATH]
}

/** command-code：mod 从进程环境读取桥接配置。 */
export function commandCodeBridgeEnvironment(sessionId: string, adapterId: string): Record<string, string> {
  return bridgeEnvironment(sessionId, adapterId) ?? {}
}

/** claude-code：`--mcp-config` 注入替身工具，并指示模型优先使用。 */
export function claudeBridgeArgs(sessionId: string, adapterId: string): readonly string[] {
  const env = bridgeEnvironment(sessionId, adapterId)
  if (env === undefined) return []
  const config = JSON.stringify({ mcpServers: { codingns: mcpServerConfig(env) } })
  return [
    '--mcp-config', config,
    '--append-system-prompt', bridgeSubagentGuidance('mcp__codingns__agent_subagent'),
    '--disallowedTools', 'Task',
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
 * ACP 适配器（gemini/grok/mcode）：session/new 与 session/load 都带上 MCP server。
 * 这些 CLI 没有可靠的“禁用内建子代理”开关，靠工具描述与模型选择。
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
  if (runtime === undefined || isSubagentChildSession(sessionId)) return undefined
  return {
    [BRIDGE_MARKER]: '1',
    CODINGNS_BRIDGE_URL: runtime.baseUrl,
    CODINGNS_BRIDGE_TOKEN: runtime.token,
    CODINGNS_DSH_SESSION_ID: sessionId,
    CODINGNS_ADAPTER_ID: adapterId,
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
  return [
    `When the user asks to use parallel sessions, parallel agents, subagents, or to delegate/offload work, call the MCP tool \`${toolName}\``,
    '— do not complete the whole task inline. Each call starts one self-contained subtask as a DSH-native subagent session and returns immediately with a child session id.',
    'Issue independent calls in the same batch without waiting for one another; use action=read for an immediate status check, action=send to deliver a follow-up message, and action=wait for a bounded wait before starting dependent work. If a child is failed, you must read/wait its status first, then assess whether to recreate it or take over with send.',
    'Provide a complete, self-contained `prompt` for every call; optionally pass `agent` (external coding agent id) and `model`.',
  ].join(' ')
}

function isSubagentChildSession(sessionId: string): boolean {
  if (sessionId === '') return false
  try {
    return getAdapterRegistry()?.sessionRecords?.get(sessionId)?.origin === 'subagent'
  } catch {
    return false
  }
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

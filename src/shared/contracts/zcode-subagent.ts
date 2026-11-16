/**
 * ZCode 子代理的只读投影契约。
 *
 * 两种来源统一到同一份「参与者」模型，界面才能用一套 ZCode 原生风格渲染：
 * - `native`：ZCode 内建 Agent 工具（别名 Task）开出的 `sess_subagent_*` 会话；
 * - `workflow`：原生动态工作流的参与者会话（`sess_dwf-*`）。
 *
 * 契约只承载界面需要的字段：标题、状态、模型、用量、结果与产物元数据。
 * 不承载会话目录、原生数据库路径、脚本源码或凭据；正文一律在 Host 侧截断。
 */

/** 原生子代理的终态取值（来自 ZCode `last_outcome` 与 `session_task_link.status`）。 */
export type ZcodeSubagentStatus =
  | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'pending' | 'unknown'

export interface ZcodeSubagentArtifact {
  id: string
  /** 交付物文件名或标题，供界面直接展示。 */
  name: string
  /** 归入产物区的理由（扩展名或工具名），只用于展示。 */
  kind: string
  /** 首次落盘时间。 */
  time: number
  /** 产出它的参与者 ID，用于在步骤树里回链。 */
  agentId: string
}

export interface ZcodeSubagentSummary {
  id: string
  origin: 'native' | 'workflow'
  /** 一行标题；原生子代理取任务描述，工作流参与者取 dwf_node 步骤标签或 dwf_actor 名称。 */
  title: string
  status: ZcodeSubagentStatus
  /** 原生子代理类型（general-purpose / Explore 等），工作流参与者为空。 */
  subagentType: string
  model: string
  createdAt: number
  updatedAt: number
  /** 工作流 participants 的归属：run ID、规范 activity ID、阶段、call path。 */
  runId: string
  activityId: string
  /** 原生工作流的阶段归属（用于步骤分组）；内建子代理为空。 */
  phase: string
  callPath: string
  /** 标题存在时的完整任务提示词，界面在摘要里单行截断。 */
  prompt: string
  /** 子代理最终报告或工作流 activity 结果；未结束为空。 */
  result: string
  /** 失败原因；未失败为空。 */
  error: string
  /** 该参与者的 token 用量合计；没有用量记录时为 null。 */
  tokens: number | null
  durationMs: number
  artifacts: ZcodeSubagentArtifact[]
}

export interface ZcodeSubagentEntry {
  id: string
  messageId: string
  role: 'user' | 'assistant' | 'tool' | 'reasoning'
  time: number
  text: string
  name: string
  status: string
  input: string
  error: string
  truncated: boolean
}

export interface ZcodeSubagentCursor {
  beforeTime: number
  beforeId: string
}

export interface ZcodeSubagentDetail {
  agent: ZcodeSubagentSummary
  entries: ZcodeSubagentEntry[]
  nextCursor: ZcodeSubagentCursor | null
}

/** 一次运行：工作流 run（含参与者与阶段）或该会话全部原生子代理。 */
export interface ZcodeSubagentRun {
  id: string
  kind: 'workflow' | 'native'
  name: string
  status: string
  createdAt: number
  updatedAt: number
  currentPhase: string
  /** 该 run 的参与者合计 token；没有用量记录时为 null。 */
  tokens: number | null
  result: string
  error: string
  resumedFrom: string
  agents: ZcodeSubagentSummary[]
  artifacts: ZcodeSubagentArtifact[]
  /** 原生工作流已保存的阶段图；原生子代理分组没有阶段图时为空。 */
  phases: { id: string; name: string; status: string; done: number; total: number }[]
  truncated: boolean
}

export interface ZcodeSubagentSnapshot {
  available: boolean
  /** 不可用原因：database-missing / schema-unsupported / not-zcode。 */
  reason: string | null
  runs: ZcodeSubagentRun[]
  hasMore: boolean
}

export function subagentIsActive(status: ZcodeSubagentStatus): boolean {
  return status === 'running' || status === 'pending'
}

export function subagentIsTerminal(status: ZcodeSubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'cancelled'
}

/** 归一化原生状态文本；未知取值落到 unknown，绝不猜测为成功。 */
export function normalizeSubagentStatus(value: string): ZcodeSubagentStatus {
  const status = value.trim().toLowerCase()
  if (status === 'running' || status === 'active' || status === 'executing' || status === 'in_progress') return 'running'
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'cancelled' || status === 'canceled' || status === 'aborted') return 'cancelled'
  if (status === 'pending' || status === 'queued' || status === 'created' || status === 'dispatched' || status === 'waiting') return 'pending'
  return 'unknown'
}

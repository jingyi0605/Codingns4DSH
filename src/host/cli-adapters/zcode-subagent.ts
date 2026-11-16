/**
 * ZCode 子代理只读读取器。
 *
 * 数据来源是 ZCode 自己的本地库（`~/.zcode/cli/db/db.sqlite`），
 * 只读打开、只取界面需要的字段、正文在 Host 侧截断。
 *
 * 表选择是实测结论（本机 ZCode 3.18.2，2026-11-15 核对）：
 * - 内建 `Agent` 工具（别名 `Task`）的子代理：`session.task_type = 'subagent_child'`，
 *   父级列名是 `parent_id`（旧库 `parent_session_id`）。
 * - 原生动态工作流的参与者：`session.task_type = 'workflow_child'`，归属链是
 *   `dwf_run.parent_session_id → dwf_actor.session_id`。
 * - **不要**用 `workflow_run` / `workflow_activity`：这两张表在本代 ZCode 里是空的
 *   （实测 0 行），真实数据在 `dwf_run` / `dwf_actor` / `dwf_node` / `dwf_event`。
 *
 * 为什么不用 app-server 的 `session/subagents`：那个入口只在会话进程存活时可用，
 * 且 `session/read` 对已结束子会话报 `-32004`；历史子代理必须离线可查。
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ZCODE_WORKFLOW_ACTIVE_STATUSES } from '../../shared/contracts/zcode-workflow.js'
import {
  normalizeSubagentStatus,
  type ZcodeSubagentArtifact,
  type ZcodeSubagentCursor,
  type ZcodeSubagentDetail,
  type ZcodeSubagentEntry,
  type ZcodeSubagentRun,
  type ZcodeSubagentSnapshot,
  type ZcodeSubagentSummary,
} from '../../shared/contracts/zcode-subagent.js'

type Row = Record<string, unknown>
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown, limit = 6000): string => typeof value === 'string' ? value.slice(0, limit) : ''
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
function json(value: unknown): Row { try { return object(JSON.parse(text(value, 262144))) } catch { return {} } }
function preview(value: unknown, limit = 6000): string {
  const raw = text(value, limit + 2)
  if (raw === '') return ''
  try { const parsed: unknown = JSON.parse(raw); return (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)).slice(0, limit) } catch { return raw.slice(0, limit) }
}
/** 会话 ID 只允许出现原生库的稳定形状，避免把客户端输入拼进查询。 */
const SESSION_ID = /^[a-zA-Z0-9_.:-]{1,200}$/u
const AGENT_ID = /^(?:wf|sa):/u

const ARTIFACT_EXTENSIONS = new Set(['md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'txt', 'log', 'yaml', 'yml', 'toml', 'ini', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'wav', 'mp3', 'pdf', 'docx', 'xlsx', 'pptx', 'zip', 'tgz', 'patch', 'diff'])
const ARTIFACT_LIMIT = 40
const WRITE_TOOLS = /^(?:Write|Edit|MultiEdit|write|edit|create_file|str_replace_editor|apply_patch|NotebookEdit|NotebookWrite)$/u
const REQUIRED_TABLES = ['session', 'message', 'part', 'dwf_run', 'dwf_actor', 'dwf_node'] as const

interface SessionRow {
  id: string; parentId: string; taskType: string; title: string; directory: string
  createdAt: number; updatedAt: number; outcome: string
}

/** 打开只读库并校验必需表；缺表时抛出 `schema-unsupported`。 */
function openReadOnly(databasePath: string): { db: DatabaseSync; columns: ReadonlySet<string> } | null {
  if (!existsSync(databasePath)) return null
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => text(row.name, 200)))
    for (const required of REQUIRED_TABLES) if (!names.has(required)) throw new Error('schema-unsupported')
    const requiredColumns: Record<string, string[]> = {
      session: ['id', 'title', 'directory', 'time_created', 'time_updated'],
      message: ['id', 'data'],
      part: ['id', 'session_id', 'message_id', 'time_created', 'data'],
      dwf_run: ['id', 'parent_session_id', 'name', 'status', 'spent_tokens', 'resumed_from', 'result_json', 'failure_json', 'time_created', 'time_updated'],
      dwf_actor: ['id', 'run_id', 'site_id', 'ordinal', 'name', 'resolved_model', 'session_id', 'time_created', 'time_updated'],
      dwf_node: ['id', 'run_id', 'site_id', 'ordinal', 'kind', 'status', 'actor_site_id', 'actor_ordinal', 'input_json', 'result_json', 'error_json', 'time_created', 'time_updated'],
    }
    for (const [table, required] of Object.entries(requiredColumns)) {
      const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => text(row.name, 100)))
      if (required.some(column => !actual.has(column))) throw new Error('schema-unsupported')
    }
    const columns = new Set(db.prepare('PRAGMA table_info(session)').all().map(row => text(row.name, 100)))
    if (!(columns.has('parent_id') || columns.has('parent_session_id')) || !(columns.has('task_type') || columns.has('session_kind'))) throw new Error('schema-unsupported')
    return { db, columns }
  } catch (error) {
    try { db.close() } catch { /* 关闭失败不掩盖原始错误 */ }
    throw error
  }
}

/** ZCode 的会话表列名在两代 schema 间变过，按真实列名拼列清单而不是猜。 */
function sessionColumn(columns: ReadonlySet<string>, current: string, legacy: string): string {
  return columns.has(current) ? current : legacy
}

function readSessionRows(db: DatabaseSync, columns: ReadonlySet<string>, parentIds: readonly string[]): SessionRow[] {
  const taskType = sessionColumn(columns, 'task_type', 'session_kind')
  const parentId = sessionColumn(columns, 'parent_id', 'parent_session_id')
  const outcome = columns.has('last_outcome') ? 'last_outcome' : "'' AS last_outcome"
  const rows = db.prepare(`SELECT id,${parentId} AS parent_id,${taskType} AS task_type,title,directory,time_created,time_updated,${outcome}
    FROM session WHERE ${parentId} IN (${parentIds.map(() => '?').join(',')})
      AND ${taskType} IN ('subagent_child','workflow_child') ORDER BY time_updated DESC,id LIMIT 401`).all(...parentIds)
  return rows.map((row): SessionRow => ({
    id: text(row.id, 200),
    parentId: text(row.parent_id, 200),
    taskType: text(row.task_type, 60),
    title: text(row.title, 400),
    directory: text(row.directory, 400),
    createdAt: number(row.time_created),
    updatedAt: number(row.time_updated),
    outcome: text(row.last_outcome, 60),
  })).filter(row => row.id !== '' && (row.taskType === 'subagent_child' || row.taskType === 'workflow_child'))
}

/** 该参与者会话的 token 合计；没有用量记录时返回 null（界面显示"未记录"而不是 0）。 */
function readAgentTokens(db: DatabaseSync, sessionId: string): number | null {
  if (sessionId === '') return null
  try {
    const row = db.prepare(`SELECT count(*) AS samples,
        sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_input_tokens,0)+coalesce(cache_creation_input_tokens,0)) AS total
      FROM model_usage WHERE session_id=?`).get(sessionId)
    return number(row?.samples) > 0 ? number(row?.total) : null
  } catch { return null }
}

/** 参与者使用的模型：取该会话最近一次用量记录里的 provider/model。 */
function readAgentModel(db: DatabaseSync, sessionId: string): string {
  if (sessionId === '') return ''
  try {
    const row = db.prepare(`SELECT provider_id, model_id FROM model_usage
      WHERE session_id=? AND coalesce(model_id,'')!='' ORDER BY started_at DESC LIMIT 1`).get(sessionId)
    const model = text(row?.model_id, 200)
    if (model === '') return ''
    const provider = text(row?.provider_id, 200)
    return provider === '' ? model : `${provider}/${model}`
  } catch { return '' }
}

/** 参与者最终报告与失败原因：最后一条用户可见 assistant 正文 + 最近的工具错误。 */
function readAgentOutcome(db: DatabaseSync, sessionId: string): { result: string; error: string } {
  if (sessionId === '') return { result: '', error: '' }
  const last = db.prepare(`SELECT substr(coalesce(json_extract(p.data,'$.text'),''),1,6001) AS body
    FROM part p JOIN message m ON m.id=p.message_id
    WHERE p.session_id=? AND json_valid(p.data) AND json_valid(m.data)
      AND json_extract(p.data,'$.type')='text' AND json_extract(m.data,'$.role')='assistant'
      AND coalesce(json_extract(p.data,'$.synthetic'),0)!=1
      AND coalesce(json_extract(m.data,'$.semantics.uiVisibility'),'')!='hidden'
    ORDER BY p.time_created DESC,p.id DESC LIMIT 1`).get(sessionId)
  const failed = db.prepare(`SELECT substr(coalesce(json_extract(p.data,'$.state.error'),''),1,2001) AS error
    FROM part p JOIN message m ON m.id=p.message_id
    WHERE p.session_id=? AND json_valid(p.data) AND json_extract(p.data,'$.type')='tool'
      AND coalesce(json_extract(p.data,'$.state.status'),'')='error'
    ORDER BY p.time_created DESC,p.id DESC LIMIT 1`).get(sessionId)
  return { result: preview(last?.body, 4000), error: preview(failed?.error, 1200) }
}

function collectPaths(value: unknown, depth = 0): string[] {
  if (depth > 3) return []
  if (typeof value === 'string') return value.length > 4 ? [value] : []
  if (Array.isArray(value)) return value.flatMap(item => collectPaths(item, depth + 1)).slice(0, 40)
  const record = object(value)
  return Object.entries(record).flatMap(([key, item]) => /path|file|target|notebook/iu.test(key) ? collectPaths(item, depth + 1) : []).slice(0, 40)
}

function readAgentArtifacts(db: DatabaseSync, sessionId: string, agentId: string): ZcodeSubagentArtifact[] {
  if (sessionId === '') return []
  const rows = db.prepare(`SELECT p.time_created AS time, substr(p.data,1,6001) AS data
    FROM part p WHERE p.session_id=? AND json_valid(p.data) AND json_extract(p.data,'$.type')='tool'
    ORDER BY p.time_created DESC LIMIT 400`).all(sessionId)
  const found: ZcodeSubagentArtifact[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const data = json(row.data)
    if (!WRITE_TOOLS.test(text(data.tool, 80))) continue
    for (const path of collectPaths(object(data.state).input)) {
      const name = path.split(/[\\/]/u).at(-1) ?? ''
      const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
      if (name === '' || !ARTIFACT_EXTENSIONS.has(extension) || seen.has(name)) continue
      seen.add(name)
      found.push({ id: `${agentId}:${name}`, name: name.slice(0, 200), kind: extension.slice(0, 40), time: number(row.time), agentId })
      if (found.length >= ARTIFACT_LIMIT) return found
    }
  }
  return found
}

interface DwfNodeRow {
  siteId: string; ordinal: number; kind: string; status: string; label: string
  createdAt: number; updatedAt: number; result: string; error: string
  actorSiteId: string; actorOrdinal: number
}

/**
 * 工作流节点。步骤名优先 `dwf_node.input_json` 里的 label/title/name；
 * 个别节点 payload 用字符串或数组表达，因此按多种形状取值。
 */
function nodeLabel(input: unknown, fallback: string): string {
  if (typeof input === 'string') return input.trim().slice(0, 300) || fallback
  if (Array.isArray(input)) { for (const item of input) { const label = nodeLabel(item, ''); if (label !== '') return label } return fallback }
  const record = object(input)
  for (const key of ['label', 'title', 'name', 'objective', 'goal']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300)
  }
  return fallback
}

function readDwfNodes(db: DatabaseSync, runId: string): DwfNodeRow[] {
  const rows = db.prepare(`SELECT site_id,ordinal,kind,status,actor_site_id,actor_ordinal,
      substr(input_json,1,12001) AS input_json, substr(result_json,1,12001) AS result_json, substr(error_json,1,4001) AS error_json,
      time_created,time_updated FROM dwf_node WHERE run_id=? ORDER BY id LIMIT 501`).all(runId)
  return rows.map((row): DwfNodeRow => ({
    siteId: text(row.site_id, 200),
    ordinal: number(row.ordinal),
    kind: text(row.kind, 40),
    status: text(row.status, 40),
    label: nodeLabel(json(row.input_json), ''),
    createdAt: number(row.time_created),
    updatedAt: number(row.time_updated),
    result: preview(row.result_json, 3000),
    error: preview(row.error_json, 1200),
    actorSiteId: text(row.actor_site_id, 200),
    actorOrdinal: number(row.actor_ordinal),
  }))
}

/** 参与者的节点集合：先按 actor 精确匹配，再退回同站点，最后退回整轮节点。 */
function nodesForActor(nodes: readonly DwfNodeRow[], siteId: string, ordinal: number): DwfNodeRow[] {
  const exact = nodes.filter(node => node.actorSiteId === siteId && node.actorOrdinal === ordinal)
  if (exact.length > 0) return exact
  const sameSite = nodes.filter(node => node.siteId === siteId)
  if (sameSite.length > 0) return sameSite
  return [...nodes]
}

/** 阶段：优先工作流图的阶段表，否则按节点 siteId 顺序分组（界面只用来分行）。 */
function readRunPhases(db: DatabaseSync, runId: string, nodes: readonly DwfNodeRow[]): ZcodeSubagentRun['phases'] {
  const graph = readRunGraph(db, runId)
  const phases = Array.isArray(graph.phases) ? graph.phases.map(object) : []
  if (phases.length > 0) {
    const steps = Array.isArray(graph.steps) ? graph.steps.map(object) : []
    return phases.map((phase, index) => {
      const id = text(phase.id, 160) || `phase-${String(index)}`
      const total = steps.filter(step => text(step.phase, 160) === id).length
      return { id, name: text(phase.name, 300) || id, status: 'completed', done: total, total }
    })
  }
  const grouped = new Map<string, DwfNodeRow[]>()
  for (const node of nodes) grouped.set(node.siteId, [...grouped.get(node.siteId) ?? [], node])
  return [...grouped.entries()].slice(0, 60).map(([siteId, owned]) => {
    const failed = owned.some(node => node.status === 'failed')
    const running = owned.some(node => node.status === 'running')
    return {
      id: siteId,
      name: owned.find(node => node.label !== '')?.label ?? siteId,
      status: failed ? 'failed' : running ? 'running' : 'completed',
      done: owned.filter(node => node.status === 'completed').length,
      total: owned.length,
    }
  })
}

/** 原生工作流阶段图存在发起工具的部件里；缺失时返回空图而不是报错。 */
function readRunGraph(db: DatabaseSync, runId: string): Row {
  try {
    const row = db.prepare(`SELECT json_extract(p.data,'$.state.metadata.display.causalityGraph') AS graph
      FROM part p WHERE p.session_id IN (SELECT parent_session_id FROM dwf_run WHERE id=?)
        AND json_valid(p.data) AND p.data LIKE '%causalityGraph%' LIMIT 1`).get(runId)
    return json(row?.graph)
  } catch { return {} }
}

function dwfActorSummary(
  actor: Row, nodes: readonly DwfNodeRow[], session: SessionRow | undefined, tokens: number | null,
  artifacts: ZcodeSubagentArtifact[], agentId: string, runId: string,
): ZcodeSubagentSummary {
  const statusText = nodes.some(node => node.status === 'running')
    ? 'running'
    : nodes.some(node => node.status === 'failed') ? 'failed' : nodes.length > 0 ? 'completed' : text(actor.status, 40)
  const created = number(actor.time_created) || session?.createdAt || 0
  const updated = number(actor.time_updated) || session?.updatedAt || created
  const lastNode = nodes.at(-1)
  const siteId = text(actor.site_id, 200)
  return {
    id: agentId,
    origin: 'workflow',
    // 实测 `dwf_node.input_json` 基本为空（只有 world-read 带 op/args），
    // 因此参与者名（修复员/复测员/撰写员）才是稳定的步骤标题。
    title: text(actor.name, 300) || siteId || agentId,
    status: normalizeSubagentStatus(statusText === '' ? session?.outcome ?? '' : statusText),
    subagentType: '',
    model: text(actor.resolved_model, 300),
    createdAt: created,
    updatedAt: updated,
    runId,
    activityId: `${siteId}:${String(number(actor.ordinal))}`,
    phase: siteId,
    callPath: siteId,
    prompt: nodes.map(node => node.label).filter(label => label !== '').join('\n').slice(0, 4000),
    result: lastNode?.result ?? '',
    error: nodes.find(node => node.error !== '')?.error ?? '',
    tokens,
    durationMs: updated > created ? updated - created : 0,
    artifacts,
  }
}

/** 内建子代理（没有工作流归属）的最小摘要。 */
function sessionSummary(session: SessionRow, tokens: number | null, artifacts: ZcodeSubagentArtifact[], agentId: string): ZcodeSubagentSummary {
  // last_outcome 为 NULL 时只能说明"还没结算"：很久没更新就不再当作进行中，
  // 否则被中断的历史子代理会永远显示成运行中。
  const status = session.outcome.trim() === ''
    ? Date.now() - session.updatedAt > 15 * 60_000 ? 'unknown' : 'running'
    : normalizeSubagentStatus(session.outcome)
  return {
    id: agentId,
    origin: 'native',
    title: session.title.slice(0, 400) || agentId,
    status,
    subagentType: readSubagentType(session.title),
    model: '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    runId: '',
    activityId: '',
    phase: '',
    callPath: '',
    prompt: '',
    result: '',
    error: '',
    tokens,
    durationMs: session.createdAt > 0 && session.updatedAt >= session.createdAt ? session.updatedAt - session.createdAt : 0,
    artifacts,
  }
}

/** 原生子代理类型：ZCode 把它写进会话标题前的提示里，取不到就留空。 */
function readSubagentType(title: string): string {
  return /subagent_type["':\s]+([A-Za-z0-9_-]{1,60})/u.exec(title)?.[1] ?? ''
}

/**
 * 主读取入口：一次返回该 DSH 会话可归属的全部参与者分组。
 *
 * 分组：每个 `dwf_run` 一组（参与者来自 `dwf_actor`，各自带上子会话的正文/用量/产物），
 * 内建 `Agent` 工具开出的子代理合成一个 `native` 组。
 */
export function readZcodeSubagents(databasePath: string, parentSessionIds: readonly string[]): ZcodeSubagentSnapshot {
  let opened: { db: DatabaseSync; columns: ReadonlySet<string> } | null
  try { opened = openReadOnly(databasePath) } catch (error) {
    return { available: false, reason: error instanceof Error && error.message === 'schema-unsupported' ? 'schema-unsupported' : 'database-unavailable', runs: [], hasMore: false }
  }
  if (opened === null) return { available: false, reason: 'database-missing', runs: [], hasMore: false }
  const { db, columns } = opened
  try {
    const ids = [...new Set(parentSessionIds.filter(id => SESSION_ID.test(id)))].slice(0, 2)
    if (ids.length === 0) return { available: true, reason: null, runs: [], hasMore: false }
    const allSessions = readSessionRows(db, columns, ids)
    const sessions = allSessions.slice(0, 400)
    const byId = new Map(sessions.map(session => [session.id, session]))
    const runRows = db.prepare(`SELECT id,name,status,spent_tokens,resumed_from,result_json,failure_json,time_created,time_updated
      FROM dwf_run WHERE parent_session_id IN (${ids.map(() => '?').join(',')})
      ORDER BY CASE WHEN lower(trim(status)) IN (${ZCODE_WORKFLOW_ACTIVE_STATUSES.map(status => `'${status}'`).join(',')}) THEN 0 ELSE 1 END,time_created DESC LIMIT 21`).all(...ids)
    const runs: ZcodeSubagentRun[] = []
    for (const runRow of runRows.slice(0, 20)) {
      const runId = text(runRow.id, 200)
      const allNodes = readDwfNodes(db, runId)
      const nodes = allNodes.slice(0, 500)
      const actorRows = db.prepare(`SELECT site_id,ordinal,name,resolved_model,session_id,time_created,time_updated
        FROM dwf_actor WHERE run_id=? ORDER BY id LIMIT 201`).all(runId)
      const agents = actorRows.slice(0, 200).flatMap((actor, index): ZcodeSubagentSummary[] => {
        const childId = text(actor.session_id, 200)
        const session = childId === '' ? undefined : byId.get(childId)
        // 参与者还没有子会话（排队/未启动）时也保留，否则步骤树会缺行。
        if (childId !== '' && session === undefined) return []
        const agentId = `wf:${runId}:${text(actor.site_id, 200)}#${String(number(actor.ordinal))}:${String(index)}`
        const owned = nodesForActor(nodes, text(actor.site_id, 200), number(actor.ordinal))
        const summary = dwfActorSummary(actor, owned, session, readAgentTokens(db, childId), readAgentArtifacts(db, childId, agentId), agentId, runId)
        const outcome = readAgentOutcome(db, childId)
        return [{ ...summary, result: summary.result || outcome.result, error: summary.error || outcome.error }]
      })
      const status = text(runRow.status, 60)
      runs.push({
        id: runId,
        kind: 'workflow',
        name: text(runRow.name, 300) || runId,
        status,
        createdAt: number(runRow.time_created),
        updatedAt: number(runRow.time_updated),
        currentPhase: '',
        tokens: number(runRow.spent_tokens) > 0 ? number(runRow.spent_tokens) : (agents.some(agent => agent.tokens !== null) ? agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0) : null),
        result: preview(runRow.result_json, 4000),
        error: preview(runRow.failure_json, 2000),
        resumedFrom: text(runRow.resumed_from, 200),
        agents,
        artifacts: agents.flatMap(agent => agent.artifacts).slice(0, ARTIFACT_LIMIT),
        phases: readRunPhases(db, runId, nodes),
        truncated: agents.length < actorRows.length || allNodes.length > 500 || allSessions.length > 400,
      })
    }
    const nativeSessions = sessions.filter(session => session.taskType === 'subagent_child')
    if (nativeSessions.length > 0) {
      const agents = nativeSessions.slice(0, 200).map((session): ZcodeSubagentSummary => {
        const agentId = `sa:${session.id}`
        const outcome = readAgentOutcome(db, session.id)
        return {
          ...sessionSummary(session, readAgentTokens(db, session.id), readAgentArtifacts(db, session.id, agentId), agentId),
          model: readAgentModel(db, session.id),
          prompt: session.title.slice(0, 4000),
          result: outcome.result,
          error: outcome.error,
        }
      })
      const active = agents.filter(agent => agent.status === 'running' || agent.status === 'pending').length
      const failed = agents.filter(agent => agent.status === 'failed').length
      const oldest = agents.reduce((min, agent) => Math.min(min, agent.createdAt), Number.MAX_SAFE_INTEGER)
      runs.push({
        id: `native:${ids[0]!}`,
        kind: 'native',
        name: '',
        status: active > 0 ? 'running' : failed > 0 ? 'failed' : agents.every(agent => agent.status === 'completed') ? 'completed' : agents.find(agent => agent.status !== 'completed')?.status ?? 'unknown',
        createdAt: oldest === Number.MAX_SAFE_INTEGER ? 0 : oldest,
        updatedAt: agents.reduce((max, agent) => Math.max(max, agent.updatedAt), 0),
        currentPhase: '',
        tokens: agents.some(agent => agent.tokens !== null) ? agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0) : null,
        result: '',
        error: '',
        resumedFrom: '',
        agents,
        artifacts: agents.flatMap(agent => agent.artifacts).slice(0, ARTIFACT_LIMIT),
        phases: [],
        truncated: nativeSessions.length > agents.length,
      })
    }
    return { available: true, reason: null, runs, hasMore: runRows.length > 20 || allSessions.length > 400 }
  } finally { try { db.close() } catch { /* 只读句柄关闭失败不影响结果 */ } }
}

function resolveWorkflowChildSession(db: DatabaseSync, parentIds: readonly string[], runId: string, actorId: string): string {
  const [siteId, ordinal] = actorId.split(':')
  if (siteId === undefined || ordinal === undefined) return ''
  const row = db.prepare(`SELECT a.session_id AS child FROM dwf_actor a JOIN dwf_run r ON r.id=a.run_id
    WHERE a.run_id=? AND a.site_id=? AND a.ordinal=? AND r.parent_session_id IN (${parentIds.map(() => '?').join(',')})`)
    .get(runId, siteId, Number(ordinal), ...parentIds)
  return text(row?.child, 200)
}

/** 单个参与者的正文时间线；分页与工作流参与者读取器同一套游标。 */
export function readZcodeSubagentDetail(
  databasePath: string,
  parentIds: readonly string[],
  agentId: string,
  options: { cursor?: ZcodeSubagentCursor } = {},
): ZcodeSubagentDetail {
  if (!AGENT_ID.test(agentId) || agentId.length > 400) throw new Error('Invalid subagent request')
  const snapshot = readZcodeSubagents(databasePath, parentIds)
  const agent = snapshot.runs.flatMap(run => run.agents).find(candidate => candidate.id === agentId)
  if (agent === undefined) throw new Error('Subagent does not belong to this session')
  const ids = [...new Set(parentIds.filter(id => SESSION_ID.test(id)))].slice(0, 2)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    const sessionId = agent.id.startsWith('sa:')
      ? agent.id.slice(3)
      : resolveWorkflowChildSession(db, ids, agent.runId, agent.activityId)
    if (sessionId === '') return { agent, entries: [], nextCursor: null }
    const cursor = options.cursor
    const pagination = cursor === undefined ? '' : 'AND (p.time_created < ? OR (p.time_created = ? AND p.id < ?))'
    const rows = db.prepare(`SELECT p.id,p.message_id,p.time_created,json_extract(p.data,'$.type') AS part_type,json_extract(m.data,'$.role') AS role,
      substr(CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.output') ELSE json_extract(p.data,'$.text') END,1,8001) AS body,
      substr(json_extract(p.data,'$.tool'),1,200) AS tool,substr(json_extract(p.data,'$.state.status'),1,100) AS status,
      substr(json_extract(p.data,'$.state.input'),1,4001) AS input,substr(json_extract(p.data,'$.state.error'),1,6001) AS error FROM part p
      JOIN message m ON m.id=p.message_id WHERE p.session_id=? AND json_valid(p.data) AND json_valid(m.data)
      AND json_extract(m.data,'$.role') IN ('user','assistant') AND coalesce(json_extract(m.data,'$.semantics.uiVisibility'),'')!='hidden'
      AND json_extract(p.data,'$.type') IN ('text','tool','reasoning') AND coalesce(json_extract(p.data,'$.synthetic'),0)!=1
      ${pagination} ORDER BY p.time_created DESC,p.id DESC LIMIT 101`).all(sessionId, ...(cursor === undefined ? [] : [cursor.beforeTime, cursor.beforeTime, cursor.beforeId]))
    const page = rows.slice(0, 100)
    const entries = [...page].reverse().map((row): ZcodeSubagentEntry => {
      const body = text(row.body, 8001), rawInput = text(row.input, 4001)
      let input = rawInput
      try { input = JSON.stringify(JSON.parse(rawInput), null, 2) } catch { /* 保留有界原文 */ }
      return {
        id: text(row.id, 200),
        messageId: text(row.message_id, 200),
        role: row.part_type === 'tool' ? 'tool' : row.part_type === 'reasoning' ? 'reasoning' : row.role === 'user' ? 'user' : 'assistant',
        time: number(row.time_created),
        text: body.slice(0, 8000),
        name: text(row.tool, 200),
        status: text(row.status, 100),
        input: input.slice(0, 4000),
        error: preview(row.error, 1200),
        truncated: body.length > 8000 || input.length > 4000 || text(row.error, 6001).length > 6000,
      }
    })
    const last = page.at(-1)
    const nextCursor = rows.length > 100 && last !== undefined ? { beforeTime: number(last.time_created), beforeId: text(last.id, 200) } : null
    return { agent, entries, nextCursor }
  } finally { try { db.close() } catch { /* 只读句柄关闭失败不影响结果 */ } }
}

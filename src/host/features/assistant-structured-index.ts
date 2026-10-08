import type { AssistantIndexEvidence, AssistantIndexFact, AssistantIndexSnapshot, AssistantNextAction, AssistantSessionAnalysis, AssistantStructuredIndex, SessionIndexEntry } from '../../shared/contracts/assistant.js'
import { redactSensitiveValues } from './assistant-summary.js'

/** 格式是 Host 协议，不允许可编辑前置提示词把内部索引改成播报稿。 */
export const ASSISTANT_INDEX_FORMAT = [
  '你正在生成供助理检索的结构化索引，不是给用户的最终回复。只输出一个合法 JSON 对象，不要代码围栏、前后说明或播报段落。',
  '固定格式优先于前置提示词中关于整段播报、句数或不使用列表的要求。各 text/action/reason 字段仍须使用简短中文口语。',
  '严格使用以下字段，不能添加、删除或改名：',
  '{"schemaVersion":1,"sessions":[{"hostId":"原值","sessionId":"原值","objective":null,"progress":[],"blockers":[],"pendingTasks":[],"nextActions":[],"openQuestions":[]}]}',
  'sessions 必须覆盖索引里的每个会话一次，不能合并不同会话或包含范围外会话。hostId/sessionId 逐字复制；不要生成工作区、时间或运行状态，Host 自行填入。',
  'objective 是用户本次工作的目标，使用事实对象或 null；不要把最新一次日志分析误当成整个项目目标。',
  'progress 是已有动作和验证结果，不等于项目已完成。blockers 是记录中确实出现的阻碍。pendingTasks 是已提出但摘录没有完成证据的任务，不能把建议填成已有待办。',
  '事实对象格式 {"text":"一句具体事实","evidence":[{"source":"summary","quote":"同一会话摘录中的连续原文"}]}。每项至少一条证据，最多三条。source 只能是 title 或 summary，quote 为对应字段里的连续原文，不能改写或引用别的会话。',
  '复制 quote 时必须保留原文片段内部的 Markdown 标记、空格和标点，包括 **、反引号和换行；不要把渲染后的纯文字当成原文。可以选择更短的连续片段，JSON 转义只做一次。',
  '只有 objective 可引用 title，其他事实与行动必须引用 summary。会话助理的推测或自述要写成“会话助理认为/报告”，不能升级为已验证结论；工具名不能证明工具成功。',
  'nextActions 是具体可做的下一步，每项格式 {"action":"具体动作","kind":"suggested","priority":"normal","reason":"为何现在要做","evidence":[{"source":"summary","quote":"连续原文"}]}。',
  'kind 只能为 recorded（原文中已明确提出的任务）或 suggested（模型新建议，未安排、未执行）。priority 只能为 high/normal/low，按阻塞、用户等待和任务依赖排序；没有证据支持就用 normal，不虚构负责人、截止时间或依赖。',
  'openQuestions 是回答进展或安排下一步仍缺少的信息，每项写一个具体问题。无证据的字段用 null/[]，不要用“已完成”“正常”填空；目标无法确定或没有正文时至少写一个信息缺口。',
  '每个文字字段最多 300 字符，每段引用 2 至 160 字符，每个事实/行动数组最多五项，信息缺口最多八项。优先保留最重要的可操作信息。原始摘录有限，不声称已检查完整历史。',
].join('\n')

/** 保留校验位置与有限原文片段，供下一次请求纠正；校验本身不自动修补模型输出。 */
export class AssistantIndexValidationError extends Error {
  constructor(readonly reason: string, readonly path: string, readonly evidence?: { readonly quote: string; readonly sourceExcerpt: string }) {
    super(`LLM 索引格式校验失败：${reason}（${path}）。请重新执行索引`)
    this.name = 'AssistantIndexValidationError'
  }
}

/** 不猜测修补非法 JSON。错误结果保留在调试运行里，不能进入问答上下文。 */
export function parseAssistantStructuredIndex(text: string, index: AssistantIndexSnapshot): AssistantStructuredIndex {
  if (text.length > 120_000) fail('结果过长，请缩小索引范围')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { fail('必须返回 JSON 对象，不能返回普通段落或代码围栏') }
  const root = record(raw, ['schemaVersion', 'sessions'], '$')
  if (root.schemaVersion !== 1 || !Array.isArray(root.sessions) || root.sessions.length !== index.entries.length) fail('版本或会话数量与当前索引不一致')
  const sources = new Map(index.entries.map((entry) => [key(entry.hostId, entry.sessionId), entry]))
  const parsed = new Map<string, AssistantSessionAnalysis>()
  for (const [number, item] of root.sessions.entries()) {
    const path = `$.sessions[${number}]`
    const row = record(item, ['hostId', 'sessionId', 'objective', 'progress', 'blockers', 'pendingTasks', 'nextActions', 'openQuestions'], path)
    const identity = key(string(row.hostId, 300, `${path}.hostId`), string(row.sessionId, 300, `${path}.sessionId`))
    const source = sources.get(identity)
    if (source === undefined || parsed.has(identity)) fail('存在范围外或重复会话', path)
    const objective = row.objective === null ? null : fact(row.objective, source, `${path}.objective`, true)
    const facts = (field: string) => array(row[field], 5, `${path}.${field}`).map((value, index) => fact(value, source, `${path}.${field}[${index}]`))
    const progress = facts('progress')
    const blockers = facts('blockers')
    const pendingTasks = facts('pendingTasks')
    const priority = { high: 0, normal: 1, low: 2 }
    const nextActions = array(row.nextActions, 5, `${path}.nextActions`).map((value, index) => action(value, source, `${path}.nextActions[${index}]`)).sort((left, right) => priority[left.priority] - priority[right.priority])
    const openQuestions = array(row.openQuestions, 8, `${path}.openQuestions`).map((value, index) => string(value, 300, `${path}.openQuestions[${index}]`))
    if ((objective === null || !source.summary) && openQuestions.length === 0) fail('目标或正文缺失时必须说明具体信息缺口', `${path}.openQuestions`)
    parsed.set(identity, {
      hostId: source.hostId, sessionId: source.sessionId, workspaceId: source.workspaceId, workspaceName: source.workspaceName,
      title: source.title, sourceStatus: source.status ?? 'unknown', updatedAt: source.updatedAt, material: source.summary ? 'excerpt' : 'unavailable',
      objective, progress, blockers, pendingTasks, nextActions, openQuestions,
    })
  }
  // 身份与顺序来自当前快照，模型无法覆盖真实状态或把会话移到另一个项目。
  return { schemaVersion: 1, generation: index.generation, sessions: index.entries.map((entry) => parsed.get(key(entry.hostId, entry.sessionId))!) }
}

function fact(value: unknown, entry: SessionIndexEntry, path: string, allowTitle = false): AssistantIndexFact {
  const item = record(value, ['text', 'evidence'], path)
  return { text: string(item.text, 300, `${path}.text`), evidence: evidence(item.evidence, entry, `${path}.evidence`, allowTitle) }
}

function action(value: unknown, entry: SessionIndexEntry, path: string): AssistantNextAction {
  const item = record(value, ['action', 'kind', 'priority', 'reason', 'evidence'], path)
  if (item.kind !== 'recorded' && item.kind !== 'suggested') fail('行动类型必须是已有任务或建议', `${path}.kind`)
  if (item.priority !== 'high' && item.priority !== 'normal' && item.priority !== 'low') fail('行动优先级无效', `${path}.priority`)
  return { action: string(item.action, 300, `${path}.action`), kind: item.kind, priority: item.priority, reason: string(item.reason, 300, `${path}.reason`), evidence: evidence(item.evidence, entry, `${path}.evidence`, false) }
}

function evidence(value: unknown, entry: SessionIndexEntry, path: string, allowTitle: boolean): readonly AssistantIndexEvidence[] {
  const items = array(value, 3, path)
  if (items.length === 0) fail('事实和行动必须附来源证据', path)
  return items.map((value, number) => {
    const position = `${path}[${number}]`
    const item = record(value, ['source', 'quote'], position)
    if (item.source !== 'summary' && !(allowTitle && item.source === 'title')) fail('此字段必须引用同一会话的正文摘录', `${position}.source`)
    const quote = string(item.quote, 160, `${position}.quote`)
    const source = item.source === 'title' ? entry.title : entry.summary
    const original = redactSensitiveValues(source ?? '')
    if (quote.length < 2 || !original.includes(quote)) {
      // 只截取用于纠正的原文，不做模糊匹配或自动接受被改写的引用。
      const found = original.indexOf(quote.slice(0, 12))
      const start = Math.max(0, (found < 0 ? original.indexOf(quote.slice(0, 6)) : found) - 24)
      throw new AssistantIndexValidationError('证据引用不在该会话的来源原文中', `${position}.quote`, { quote, sourceExcerpt: original.slice(start, start + 240) })
    }
    return { source: item.source as AssistantIndexEvidence['source'], quote }
  })
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('字段必须为对象', path)
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) fail(`对象字段必须为 ${keys.join('/')}`, path)
  return item
}

function string(value: unknown, max: number, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`文字字段必须为 1 至 ${max} 字符`, path)
  return redactSensitiveValues(value.trim())
}

function array(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`数组必须为最多 ${max} 项`, path)
  return value
}

function key(hostId: string, sessionId: string): string { return JSON.stringify([hostId, sessionId]) }
function fail(reason: string, path = '$'): never { throw new AssistantIndexValidationError(reason, path) }

/** 播报从已校验字段生成，绝不朗读内部 JSON 或未校验的模型输出。 */
export function speakAssistantStructuredIndex(result: AssistantStructuredIndex): string {
  const lines = result.sessions.slice(0, 3).map((session) => {
    const progress = session.progress.at(-1)?.text ?? '暂无可确认的进展'
    const next = session.nextActions[0]
    return `${session.workspaceName}的${session.title ?? '未命名会话'}：${progress}。${next === undefined ? '' : `${next.kind === 'suggested' ? '建议' : '待办是'}${next.action}。`}`
  })
  if (result.sessions.length > 3) lines.push(`当前共索引 ${result.sessions.length} 个会话，可以继续询问其他会话的进展。`)
  return lines.join('')
}

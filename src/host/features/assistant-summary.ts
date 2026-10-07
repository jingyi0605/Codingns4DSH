import type {
  AssistantIndexSnapshot,
  AssistantProgressSummary,
  AssistantSummaryCategory,
  AssistantSummaryOptions,
  AssistantSummarySection,
  SessionIndexEntry,
} from '../../shared/contracts/assistant.js'

export interface AssistantSummaryGroups {
  readonly waiting: readonly SessionIndexEntry[]
  readonly error: readonly SessionIndexEntry[]
  readonly running: readonly SessionIndexEntry[]
  readonly completed: readonly SessionIndexEntry[]
}

export interface AssistantSummary {
  readonly groups: AssistantSummaryGroups
  readonly unreadableCount: number
  readonly speechText: string
}

export type { AssistantSummaryCategory }

/**
 * 把索引快照转换成可播报文本。函数只读输入，不读取 DSH 服务，也不修改索引。
 * 组别顺序固定为待处理、出错、运行中、已完成，避免重要事项被截断。
 */
export function summarizeAssistantIndex(snapshot: AssistantIndexSnapshot): AssistantSummary {
  if (snapshot.scope.status === 'empty') {
    const unreadableNotice = renderUnreadableNotice(snapshot.unreadableCount)
    return {
      groups: emptyGroups(),
      unreadableCount: snapshot.unreadableCount,
      speechText: [
        `${snapshot.scope.message}，无法报告进展。`,
        unreadableNotice,
      ].filter((text) => text !== '').join(' '),
    }
  }

  const groups = groupEntries(snapshot.entries)
  const unreadableNotice = renderUnreadableNotice(snapshot.unreadableCount)
  return {
    groups,
    unreadableCount: snapshot.unreadableCount,
    speechText: [
      renderGroup('待处理', groups.waiting, '当前没有待处理项。'),
      renderGroup('出错', groups.error, '当前没有出错会话。'),
      renderGroup('运行中', groups.running, '当前没有运行中的会话。'),
      renderGroup('已完成', groups.completed, '当前没有刚完成的会话。'),
      renderUnknownNotice(snapshot.entries),
      unreadableNotice,
    ].filter((text) => text !== '').join(' '),
  }
}

/** 便于动作层直接传入索引条目。 */
export function summarizeAssistantEntries(
  entries: readonly SessionIndexEntry[],
  scope: AssistantIndexSnapshot['scope'],
  generation = 0,
  unreadableCount = 0,
  maxChars = 12000,
): AssistantSummary {
  const summary = summarizeAssistantIndex({ generation, entries, scope, unreadableCount })
  if (maxChars <= 0 || summary.speechText.length <= maxChars) return summary
  const notice = renderUnreadableNotice(unreadableCount)
  const body = notice !== '' && summary.speechText.endsWith(notice)
    ? summary.speechText.slice(0, -notice.length).trim()
    : summary.speechText
  return { ...summary, speechText: limitSpeechText(body, maxChars, notice) }
}

/** 兼容动作层使用的命名：输入索引条目，输出完整进展摘要。 */
export function summarizeAssistantSessions(
  entries: readonly SessionIndexEntry[],
  options: AssistantSummaryOptions = {},
): AssistantProgressSummary {
  const scope = options.scope ?? { status: 'ready', managedWorkspaceIds: [] }
  const unreadableCount = Math.max(0, options.unreadableCount ?? 0)
  const base = summarizeAssistantEntries(entries, scope, options.generation ?? 0, unreadableCount)
  const labels: readonly AssistantSummaryCategory[] = ['waiting', 'error', 'running', 'completed']
  const sections: AssistantSummarySection[] = labels.map((category) => ({
    category,
    entries: base.groups[category].slice(0, options.maxItemsPerCategory),
    text: renderGroup(categoryLabel(category), base.groups[category].slice(0, options.maxItemsPerCategory), emptyText(category)),
  }))
  const unreadableNotice = renderUnreadableNotice(unreadableCount)
  const speechText = limitSpeechText(
    [...sections.map((section) => section.text), renderUnknownNotice(entries, options.maxItemsPerCategory)].filter(Boolean).join(' '),
    options.maxChars,
    unreadableNotice,
  )
  return { generation: options.generation ?? 0, total: entries.length, unreadableCount, sections, speechText }
}

export const buildAssistantSummary = summarizeAssistantSessions

export const normalizeSpeechText = sanitizeSpeechText

export function redactSensitiveValues(value: string): string {
  return value
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+)\b/gu, '已隐藏凭据')
    .replace(/\b(?:api[_ -]?key|token|secret|password|密码|密钥)\s*[:=：]\s*[^\s,，;；]+/giu, '已隐藏敏感字段')
}

function groupEntries(entries: readonly SessionIndexEntry[]): AssistantSummaryGroups {
  const waiting: SessionIndexEntry[] = []
  const error: SessionIndexEntry[] = []
  const running: SessionIndexEntry[] = []
  const completed: SessionIndexEntry[] = []
  for (const entry of entries) {
    if (entry.waiting !== null) {
      waiting.push(entry)
    } else if (entry.error === true) {
      error.push(entry)
    } else if (entry.running) {
      running.push(entry)
    } else if (entry.completed) {
      completed.push(entry)
    }
  }
  return { waiting, error, running, completed }
}

/** 未知状态不进入四个业务组，但所有汇总入口都必须保留这条诊断。 */
function renderUnknownNotice(entries: readonly SessionIndexEntry[], maxItems?: number): string {
  const unknown = entries.filter((entry) => entry.waiting === null && entry.error !== true && !entry.running && !entry.completed)
  return unknown.length === 0 ? '' : `有${unknown.length}个会话状态未知，不能据此判断没有进展。${renderGroup('状态未知', unknown.slice(0, maxItems), '')}`
}

function renderGroup(label: string, entries: readonly SessionIndexEntry[], emptyText: string): string {
  if (entries.length === 0) return `${label}：${emptyText}`
  const details = entries.map(renderEntry).join('；')
  return `${label}：${details}。`
}

function renderEntry(entry: SessionIndexEntry): string {
  const title = sanitizeSpeechText(entry.title ?? '未命名会话') || '未命名会话'
  const workspace = sanitizeSpeechText(entry.workspaceName || entry.workspaceId) || '未命名工作区'
  const detail = sanitizeSpeechText(entry.summary ?? '')
  const waiting = entry.waiting === 'approval' ? '等待审批' : entry.waiting === 'question' ? '等待回答' : ''
  const suffix = waiting || detail
  return suffix ? `工作区${workspace}的${title}（${suffix}）` : `工作区${workspace}的${title}`
}

function renderUnreadableNotice(count: number): string {
  return count > 0 ? `有${count}个会话暂时无法读取，以上摘要可能不完整。` : ''
}

/** 清理 Markdown、URL、代码和常见凭据形态，结果可直接交给 TTS。 */
export function sanitizeSpeechText(value: string): string {
  return redactSensitiveValues(value)
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, '链接')
    .replace(/[>#*_~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function emptyGroups(): AssistantSummaryGroups {
  return { waiting: [], error: [], running: [], completed: [] }
}

function categoryLabel(category: AssistantSummaryCategory): string {
  return { waiting: '待处理', error: '出错', running: '运行中', completed: '已完成' }[category]
}

function emptyText(category: AssistantSummaryCategory): string {
  return {
    waiting: '当前没有待处理项。',
    error: '当前没有出错会话。',
    running: '当前没有运行中的会话。',
    completed: '当前没有刚完成的会话。',
  }[category]
}

function limitSpeechText(value: string, maxChars: number | undefined, suffix = ''): string {
  const normalizedSuffix = suffix.trim()
  if (normalizedSuffix === '') return limitSpeechTextWithoutSuffix(value, maxChars)
  if (maxChars === undefined || maxChars <= 0) return `${value} ${normalizedSuffix}`.trim()
  const separatorLength = value.trim() === '' ? 0 : 1
  const prefixBudget = maxChars - normalizedSuffix.length - separatorLength
  if (prefixBudget <= 0) return normalizedSuffix
  const prefix = limitSpeechTextWithoutSuffix(value, prefixBudget)
  return `${prefix} ${normalizedSuffix}`.trim()
}

function limitSpeechTextWithoutSuffix(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || maxChars <= 0 || value.length <= maxChars) return value
  const budget = Math.max(1, maxChars - 1)
  const sections = value.split(/(?<=。)\s+/u)
  const kept: string[] = []
  let used = 0
  for (const section of sections) {
    const candidate = section.trim()
    if (candidate === '') continue
    if (used + candidate.length <= budget) {
      kept.push(candidate)
      used += candidate.length + (kept.length > 1 ? 1 : 0)
      continue
    }
    // 保留当前段落中完整的会话条目，避免从任意字符处截断标题或状态。
    const prefix = candidate.split('：', 1)[0] ?? candidate
    const label = `${prefix}：`
    if (used + label.length <= budget && kept.length === 0) kept.push(label.trim())
    break
  }
  const result = kept.join(' ').trim()
  return `${result || value.slice(0, budget).trim()}。`
}

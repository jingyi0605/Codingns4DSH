import { createElement as h, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ZcodeSubagentCursor, ZcodeSubagentDetail, ZcodeSubagentEntry, ZcodeSubagentSummary } from '../shared/contracts/zcode-subagent.js'
import { subagentIsActive, subagentIsTerminal } from '../shared/contracts/zcode-subagent.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc, errorMessage } from './cli-catalog.js'
import type { CodingNsTranslator } from './locale.js'
import { dshThemeColor } from './theme.js'

/** 参与者时间线按条目 ID 去重合并：轮询期间同一条流式记录只更新不重复。 */
export function mergeSubagentEntries(previous: readonly ZcodeSubagentEntry[], latest: readonly ZcodeSubagentEntry[]): ZcodeSubagentEntry[] {
  const entries = new Map(previous.map(entry => [entry.id, entry]))
  for (const entry of latest) entries.set(entry.id, entry)
  return [...entries.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).slice(-1000)
}

/** 紧凑时长：秒/分秒/时分秒，超过一天用"天"收口。 */
export function formatAgentDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

/** token 一律用项目统一的 K/M/B 紧凑格式；未记录用量时返回空串由调用方替换文案。 */
export function formatAgentTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return ''
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`
  if (tokens < 1_000_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return `${(tokens / 1_000_000_000).toFixed(1)}B`
}

function time(value: number): string {
  return value > 0 ? new Date(value).toLocaleTimeString() : '—'
}

/** 原生参与者状态在界面上的颜色；未知状态保持中性色，不冒充成功。 */
export function agentStatusColor(status: string): string {
  if (status === 'completed') return dshThemeColor.success
  if (status === 'failed' || status === 'interrupted') return dshThemeColor.error
  if (status === 'cancelled') return dshThemeColor.labelSecondary
  if (status === 'running' || status === 'pending' || status === 'executing') return dshThemeColor.accent
  return dshThemeColor.labelTertiary
}

export function agentStatusLabel(status: string, t: CodingNsTranslator): string {
  if (status === 'unknown') return t('agent.unknown')
  const key = `workflow.status.${status}`, label = t(key)
  return label === key ? status || t('agent.unknown') : label
}

export function AgentProgress({ rpc, sessionId, agentId, t }: {
  rpc: CodingNsRpcClient; sessionId: string; agentId: string; t: CodingNsTranslator
}): ReactElement {
  const [detail, setDetail] = useState<ZcodeSubagentDetail | null>(null), [entries, setEntries] = useState<ZcodeSubagentEntry[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [checked, setChecked] = useState('')
  const [cursor, setCursor] = useState<ZcodeSubagentCursor | null>(null)
  const rpcRef = useRef(rpc); rpcRef.current = rpc
  const request = useRef<(cursor?: ZcodeSubagentCursor) => void>(() => undefined)
  useEffect(() => {
    setDetail(null); setEntries([]); setCursor(null); setError(''); setChecked(''); setBusy(false)
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, pending = false, loadedOlder = false
    const load = async (before?: ZcodeSubagentCursor): Promise<void> => {
      if (pending || controller.signal.aborted || document.hidden) return
      pending = true; setBusy(true); clearTimeout(timer)
      let completed = false
      try {
        const value = await callCliRpc<ZcodeSubagentDetail>(rpcRef.current, 'subagent/agent', { sessionId, agentId, ...(before === undefined ? {} : { cursor: before }) }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
        if (controller.signal.aborted) return
        if (before !== undefined) loadedOlder = true
        setDetail(value); setEntries(previous => mergeSubagentEntries(previous, value.entries)); setError(''); setChecked(new Date().toLocaleTimeString())
        if (before !== undefined || !loadedOlder) setCursor(value.nextCursor)
        // 结束的参与者不再轮询，避免面板常开时反复开库。
        completed = subagentIsTerminal(value.agent.status) && value.entries.length > 0 && value.nextCursor === null
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)) }
      finally {
        pending = false
        if (!controller.signal.aborted) {
          setBusy(false)
          if (!completed) timer = setTimeout(() => { void load() }, 3000)
        }
      }
    }
    request.current = before => { void load(before) }
    const trigger = (): void => { void load() }
    document.addEventListener('visibilitychange', trigger); trigger()
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', trigger); request.current = () => undefined }
  }, [sessionId, agentId])
  const agent: ZcodeSubagentSummary | undefined = detail?.agent
  const tokens = formatAgentTokens(agent?.tokens ?? null)
  return h('section', { 'data-codingns-subagent-agent': agentId, 'aria-label': t('workflow.actorProgress'), className: 'codingns-subagents__detail' },
    h('div', { className: 'codingns-subagents__headline' },
      h('span', { 'aria-hidden': true, className: 'codingns-subagents__headdot', style: { background: agentStatusColor(agent?.status ?? 'unknown') } }),
      h('strong', { className: 'codingns-subagents__detailtitle' }, agent?.title || t('workflow.actorProgress')),
      agent ? h('span', { 'data-agent-status': agent.status, className: 'codingns-subagents__status', style: { color: agentStatusColor(agent.status) } }, agentStatusLabel(agent.status, t)) : null,
      h('button', { type: 'button', className: 'codingns-subagents__button', disabled: busy, onClick: () => request.current() }, t(busy ? 'workflow.refreshing' : 'workflow.refresh'))),
    agent === undefined ? null : h('div', { className: 'codingns-subagents__metarow' },
      h('span', null, t('agent.meta', { started: time(agent.createdAt), duration: formatAgentDuration(agent.durationMs) })),
      agent.model === '' ? null : h('span', null, t('agent.model', { model: agent.model })),
      h('span', null, tokens === '' ? t('agent.tokensUnrecorded') : t('workflow.tokens', { tokens })),
      agent.subagentType === '' ? null : h('span', null, agent.subagentType)),
    h('p', { className: 'codingns-subagents__note', style: { marginTop: 0 } }, t('workflow.actorReadOnly')),
    checked === '' ? null : h('p', { className: 'codingns-subagents__note' }, t('workflow.checked', { time: checked })),
    error === '' ? null : h('div', { role: 'alert', className: 'codingns-subagents__disabled', style: { margin: '10px 0', overflowWrap: 'anywhere' } }, detail ? t('workflow.stale') : '', ' ', error),
    agent !== undefined && agent.prompt !== '' ? h('details', { className: 'codingns-subagents__section' }, h('summary', { className: 'codingns-subagents__entrysummary' }, t('agent.task')), h('pre', { className: 'codingns-subagents__pre' }, agent.prompt)) : null,
    agent !== undefined && agent.error !== '' ? h('details', { open: true, className: 'codingns-subagents__section' }, h('summary', { className: 'codingns-subagents__entrysummary codingns-subagents__disabled' }, t('agent.error')), h('pre', { className: 'codingns-subagents__pre codingns-subagents__disabled' }, agent.error)) : null,
    agent !== undefined && agent.result !== '' ? h('details', { open: true, className: 'codingns-subagents__section' }, h('summary', { className: 'codingns-subagents__entrysummary' }, t('agent.result')), h('pre', { className: 'codingns-subagents__pre' }, agent.result)) : null,
    cursor === null ? null : h('button', { type: 'button', className: 'codingns-subagents__button', disabled: busy, onClick: () => request.current(cursor) }, t('workflow.loadOlder')),
    agent !== undefined && detail !== null && detail.entries.length === 0 && cursor === null && !subagentIsActive(agent.status) && entries.length === 0 ? h('p', { className: 'codingns-subagents__note' }, t('workflow.actorEmpty')) : null,
    ...entries.map(entry => entry.role === 'tool' || entry.role === 'reasoning'
      ? h('details', { key: entry.id, 'data-codingns-subagent-entry': entry.id, open: entry.status === 'running' || entry.status === 'error', className: 'codingns-subagents__entry' },
        h('summary', { className: 'codingns-subagents__entrysummary' }, entry.role === 'tool' ? `${entry.name} · ${agentStatusLabel(entry.status, t)}` : t('workflow.reasoning'), ' · ', time(entry.time)),
        entry.input === '' ? null : h('pre', { className: 'codingns-subagents__pre' }, entry.input),
        entry.error === '' ? null : h('pre', { className: 'codingns-subagents__pre codingns-subagents__disabled' }, entry.error),
        entry.text === '' ? null : h('pre', { className: 'codingns-subagents__pre' }, entry.text),
        entry.truncated ? h('p', { className: 'codingns-subagents__note' }, t('workflow.entryTruncated')) : null)
      : h('article', { key: entry.id, 'data-codingns-subagent-entry': entry.id, className: entry.role === 'user' ? 'codingns-subagents__bubble codingns-subagents__bubble--user' : 'codingns-subagents__bubble' },
        h('div', { className: 'codingns-subagents__entrymeta' }, t(entry.role === 'user' ? 'agent.task' : 'agent.report'), ' · ', time(entry.time)),
        h('pre', { className: 'codingns-subagents__pre' }, entry.text), entry.truncated ? h('p', { className: 'codingns-subagents__note' }, t('workflow.entryTruncated')) : null)),
    entries.length >= 1000 ? h('p', { className: 'codingns-subagents__note' }, t('agent.entriesLimit')) : null)
}

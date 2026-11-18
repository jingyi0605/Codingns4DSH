import { createElement as h, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ZcodeSubagentArtifact, ZcodeSubagentRun, ZcodeSubagentSnapshot, ZcodeSubagentSummary } from '../shared/contracts/zcode-subagent.js'
import { subagentIsActive, subagentIsTerminal } from '../shared/contracts/zcode-subagent.js'
import { workflowIsActive, workflowIsTerminal } from '../shared/contracts/zcode-workflow.js'
import type { CodingNsClientServices, CodingNsRpcClient } from './features/types.js'
import { callCliRpc, errorMessage } from './cli-catalog.js'
import { CliSettingsDialog } from './cli-settings-dialog.js'
import { useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { publishSessionAdapter, sessionAdapterId, subscribeSessionAdapters } from './session-adapter-cache.js'
import { AgentProgress, agentStatusLabel, formatAgentDuration, formatAgentTokens } from './zcode-agent.js'
import { zcodeSubagentStyles } from './zcode-subagent-styles.js'

function installWorkflowHeaderStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('codingns-workflow-header-style')) return
  const style = document.createElement('style'); style.id = 'codingns-workflow-header-style'
  style.textContent = zcodeSubagentStyles
  document.head.appendChild(style)
}

function Chevron({ open = false }: { open?: boolean }): ReactElement {
  return h('svg', { className: 'codingns-subagents__chevron', 'data-open': open, 'aria-hidden': true, viewBox: '0 0 16 16', fill: 'none' },
    h('path', { d: 'm6 4 4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

/** Keep the user's toggle through polling; a lifecycle change restores the automatic state. */
function useRunExpansion(id: string, active: boolean, initial?: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(initial ?? active)
  useEffect(() => { setOpen(initial ?? active) }, [id, active, initial])
  return [open, () => setOpen(value => !value)]
}

interface AgentStep { id: string; label: string; phase: string; agents: ZcodeSubagentSummary[] }

export function agentSteps(run: ZcodeSubagentRun): AgentStep[] {
  if (run.kind === 'native' || run.phases.length === 0) {
    return run.agents.length === 0 ? [] : [{ id: run.id, label: '', phase: '', agents: run.agents }]
  }
  const steps: AgentStep[] = run.phases.map((phase, index) => ({ id: phase.id, label: phase.name || `#${String(index + 1)}`, phase: phase.id, agents: [] }))
  const fallback: AgentStep[] = []
  for (const agent of run.agents) {
    const step = steps.find(candidate => candidate.id === agent.phase || candidate.label === agent.phase)
    if (step === undefined) fallback.push({ id: `agent:${agent.id}`, label: agent.title, phase: '', agents: [agent] })
    else step.agents.push(agent)
  }
  return [...steps.filter(step => step.agents.length > 0), ...fallback]
}

function stepState(step: AgentStep): { status: string; done: number; total: number } {
  const done = step.agents.filter(agent => agent.status === 'completed').length
  const active = step.agents.some(agent => subagentIsActive(agent.status))
  const failed = step.agents.find(agent => agent.status === 'failed' || agent.status === 'interrupted')
  return { status: active ? 'running' : failed?.status ?? (done === step.agents.length ? 'completed' : 'unknown'), done, total: step.agents.length }
}

export function agentSummaryLine(run: ZcodeSubagentRun, t: CodingNsTranslator): string {
  const total = run.agents.length
  const done = run.agents.filter(agent => agent.status === 'completed').length
  const tokens = formatAgentTokens(run.tokens)
  const key = run.kind === 'workflow' ? 'workflow.agentSummary' : 'agent.summary'
  return t(tokens === '' ? `${key}NoTokens` : key, { agents: total, done, total, tokens, artifacts: run.artifacts.length })
}

function StatusIcon({ status }: { status: string }): ReactElement {
  const active = workflowIsActive(status), failed = ['failed', 'error', 'interrupted', 'stalled'].includes(status)
  return h('svg', { className: 'codingns-subagents__stateicon', 'data-active': active, 'data-failed': failed, 'aria-hidden': true, viewBox: '0 0 20 20', fill: 'none' },
    h('circle', { cx: 10, cy: 10, r: 7.5, stroke: 'currentColor', strokeWidth: 1.5, opacity: active ? .3 : .6 }),
    active ? h('path', { className: 'codingns-subagents__spinner', d: 'M2.5 10a7.5 7.5 0 0 1 7.5-7.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })
      : h('path', { d: failed ? 'M10 6v5m0 3h.01' : status === 'completed' ? 'm6.5 10 2.3 2.3 4.7-4.6' : status === 'unknown' ? 'M8 7.5a2 2 0 1 1 3 1.7c-.8.4-1 1-1 1.8m0 2h.01' : 'M7.5 7.5h5v5h-5z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function Metrics({ tokens, durationMs, t }: { tokens: number | null; durationMs: number; t: CodingNsTranslator }): ReactElement {
  const value = formatAgentTokens(tokens)
  const duration = formatAgentDuration(durationMs).replace(/(\d+)d/gu, t('agent.unitDay', { value: '$1' })).replace(/(\d+)h/gu, t('agent.unitHour', { value: '$1' })).replace(/(\d+)m/gu, t('agent.unitMinute', { value: '$1' })).replace(/(\d+)s/gu, t('agent.unitSecond', { value: '$1' }))
  return h('span', { className: 'codingns-subagents__metrics' },
    h('span', { title: value === '' ? t('agent.tokensUnrecorded') : t('workflow.tokens', { tokens: value }) }, value === '' ? '—' : `${value} tok`), h('span', null, duration))
}

function AgentRow({ agent, t, onOpenAgent }: { agent: ZcodeSubagentSummary; t: CodingNsTranslator; onOpenAgent?: (id: string) => void }): ReactElement {
  return h('button', {
    type: 'button', 'data-codingns-agent-row': agent.id, disabled: onOpenAgent === undefined, title: agent.title,
    onClick: () => onOpenAgent?.(agent.id), 'aria-label': t('agent.openAria', { name: agent.title || agent.id }), className: 'codingns-subagents__row',
  },
  h(StatusIcon, { status: agent.status }),
  h('span', { className: 'codingns-subagents__rowmain' },
    h('span', { className: 'codingns-subagents__rowtitle' }, agent.title || agent.subagentType || agent.id),
    h('span', { className: 'codingns-subagents__rowmeta', title: agent.error || agent.result || agent.prompt || agent.model }, [agentStatusLabel(agent.status, t), agent.error || agent.result || agent.prompt || agent.model].filter(Boolean).join(' · '))),
  h(Metrics, { tokens: agent.tokens, durationMs: agent.durationMs, t }),
  h(Chevron, {}))
}

function StepRow({ step, t, onOpenAgent }: { step: AgentStep; t: CodingNsTranslator; onOpenAgent?: (id: string) => void }): ReactElement {
  const state = stepState(step)
  const [open, toggle] = useRunExpansion(step.id, workflowIsActive(state.status))
  return h('div', { 'data-codingns-agent-step': step.id, className: 'codingns-subagents__step' },
    h('button', { type: 'button', 'aria-expanded': open, onClick: toggle, className: 'codingns-subagents__steprow' },
      h(StatusIcon, { status: state.status }),
      h('span', { className: 'codingns-subagents__steplabel' }, step.label),
      h('span', { 'data-codingns-agent-step-count': `${String(state.done)}/${String(state.total)}`, className: 'codingns-subagents__count' }, `${String(state.done)}/${String(state.total)}`),
      h(Chevron, { open })),
    open ? h('div', { className: 'codingns-subagents__rows codingns-subagents__parallel', 'data-codingns-parallel': step.id }, ...step.agents.map(agent => h(AgentRow, { key: agent.id, agent, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) }))) : null)
}

function NativeRows({ run, t, onOpenAgent }: { run: ZcodeSubagentRun; t: CodingNsTranslator; onOpenAgent?: (id: string) => void }): ReactElement {
  const [endedOpen, setEndedOpen] = useState(false)
  const live = run.agents.filter(agent => !subagentIsTerminal(agent.status))
  const ended = run.agents.filter(agent => subagentIsTerminal(agent.status))
  const rows = (agents: ZcodeSubagentSummary[]) => agents.map(agent => h(AgentRow, { key: agent.id, agent, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) }))
  return h('div', { className: 'codingns-subagents__rows' }, ...rows(live),
    ended.length === 0 ? null : h('div', { className: 'codingns-subagents__ended', 'data-codingns-ended-agents': ended.length },
      h('button', { type: 'button', className: 'codingns-subagents__fold', 'aria-expanded': endedOpen, onClick: () => setEndedOpen(value => !value) }, h(Chevron, { open: endedOpen }), t('agent.endedCount', { count: ended.length })),
      endedOpen ? rows(ended) : null))
}

function ArtifactSection({ run, t }: { run: ZcodeSubagentRun; t: CodingNsTranslator }): ReactElement | null {
  if (run.artifacts.length === 0) return null
  const owner = (artifact: ZcodeSubagentArtifact): string => run.agents.find(agent => agent.id === artifact.agentId)?.title ?? ''
  return h('section', { 'data-codingns-agent-artifacts': run.artifacts.length, className: 'codingns-subagents__section codingns-subagents__block' },
    h('div', { className: 'codingns-subagents__sectionhead' },
      h('span', { className: 'codingns-subagents__sectiontitle' }, t('agent.artifacts')),
      h('span', { className: 'codingns-subagents__sectionmeta' }, t('agent.artifactTimes', { count: run.artifacts.length }))),
    h('div', { className: 'codingns-subagents__artifacts' },
      ...run.artifacts.map(artifact => h('article', { key: artifact.id, 'data-codingns-artifact': artifact.name, className: 'codingns-subagents__artifact' },
        h('div', { className: 'codingns-subagents__artifactname' }, artifact.name),
        h('div', { className: 'codingns-subagents__artifactmeta' }, [artifact.kind.toUpperCase(), artifact.time > 0 ? new Date(artifact.time).toLocaleString() : '', owner(artifact) === '' ? '' : t('agent.artifactOpen', { name: owner(artifact) })].filter(Boolean).join(' · '))))))
}

/** Workflow status is authoritative, even when its participant sessions have already ended. */
export function ZcodeSubagentCard({ run, t, onOpenAgent, defaultOpen }: {
  run: ZcodeSubagentRun; t: CodingNsTranslator; onOpenAgent?: (id: string) => void; defaultOpen?: boolean
}): ReactElement {
  const [open, toggle] = useRunExpansion(run.id, run.kind === 'native' || workflowIsActive(run.status), defaultOpen)
  const title = run.kind === 'native' ? t('agent.nativeGroup', { count: run.agents.length }) : run.name || run.id
  const steps = agentSteps(run)
  if (run.kind === 'native') return h('section', { 'data-codingns-subagent-run': run.id, 'data-codingns-subagent-kind': run.kind, 'data-open': true, className: 'codingns-subagents__native' }, h(NativeRows, { run, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) }),
    run.artifacts.length === 0 ? null : h('details', { className: 'codingns-subagents__section codingns-subagents__native-artifacts' }, h('summary', { className: 'codingns-subagents__entrysummary' }, t('agent.artifacts'), ' · ', t('agent.artifactTimes', { count: run.artifacts.length })), h(ArtifactSection, { run, t })),
    run.truncated ? h('p', { className: 'codingns-subagents__note' }, t('agent.truncated')) : null)
  return h('section', { 'data-codingns-subagent-run': run.id, 'data-codingns-subagent-kind': run.kind, 'data-open': open, className: 'codingns-subagents__card' },
    h('button', { type: 'button', 'aria-expanded': open, 'aria-label': t(open ? 'agent.collapse' : 'agent.expand', { name: title }), onClick: toggle, className: 'codingns-subagents__header' },
      h(StatusIcon, { status: run.status }),
      h('span', { className: 'codingns-subagents__title' }, title),
      h(Metrics, { tokens: run.tokens, durationMs: run.updatedAt > 0 && run.createdAt > 0 ? Math.max(0, run.updatedAt - run.createdAt) : -1, t }),
      h(Chevron, { open }),
      h('span', { 'data-codingns-agent-summary': '', title: agentSummaryLine(run, t), className: 'codingns-subagents__summary' }, [agentStatusLabel(run.status, t), workflowIsActive(run.status) ? run.currentPhase : '', t('workflow.participantCount', { count: run.agents.length }), t('workflow.doneCount', { done: run.agents.filter(agent => agent.status === 'completed').length, total: run.agents.length })].filter(Boolean).join(' · '))),
    open ? h('div', { className: 'codingns-subagents__cardbody' },
      run.agents.length === 0 ? h('p', { className: 'codingns-subagents__note' }, t(run.kind === 'workflow' ? 'workflow.actorWaiting' : 'agent.empty'))
        : run.phases.length === 0
          ? h('div', { className: 'codingns-subagents__rows codingns-subagents__parallel', 'data-codingns-parallel': run.id }, ...run.agents.map(agent => h(AgentRow, { key: agent.id, agent, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) })))
          : h('div', { 'aria-label': t('agent.steps'), className: 'codingns-subagents__steps' }, ...steps.map(step => h(StepRow, { key: step.id, step, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) }))),
      run.truncated ? h('p', { className: 'codingns-subagents__note' }, t('agent.truncated')) : null,
      run.error === '' ? null : h('details', { open: true, className: 'codingns-subagents__section codingns-subagents__block' }, h('summary', { className: 'codingns-subagents__entrysummary codingns-subagents__disabled' }, t('agent.error')), h('pre', { className: 'codingns-subagents__pre codingns-subagents__disabled' }, run.error)),
      run.result === '' ? null : h('details', { className: 'codingns-subagents__section codingns-subagents__block' }, h('summary', { className: 'codingns-subagents__entrysummary' }, t('agent.result')), h('pre', { className: 'codingns-subagents__pre' }, run.result)),
      h(ArtifactSection, { run, t })) : null)
}

export function ZcodeSubagentOverview({ runs, t, onOpenAgent }: { runs: readonly ZcodeSubagentRun[]; t: CodingNsTranslator; onOpenAgent?: (id: string) => void }): ReactElement {
  const [nativeOpen, setNativeOpen] = useState(true), [workflowOpen, setWorkflowOpen] = useState(true)
  const workflows = runs.filter(run => run.kind === 'workflow').sort((a, b) => Number(workflowIsActive(b.status)) - Number(workflowIsActive(a.status)) || b.createdAt - a.createdAt)
  const native = runs.filter(run => run.kind === 'native')
  const active = workflows.filter(run => workflowIsActive(run.status)).length
  const group = (kind: string, items: ZcodeSubagentRun[], count: number): ReactElement | null => items.length === 0 ? null
    : h('section', { 'data-codingns-subagent-group': kind, className: 'codingns-subagents__group', 'aria-label': t(kind === 'workflow' ? 'workflow.open' : 'agent.nativeSection') },
      h('button', { type: 'button', className: 'codingns-subagents__grouphead', 'aria-expanded': kind === 'native' ? nativeOpen : workflowOpen, onClick: () => kind === 'native' ? setNativeOpen(value => !value) : setWorkflowOpen(value => !value) },
        h(StatusIcon, { status: kind === 'native' ? native.some(run => run.agents.some(agent => subagentIsActive(agent.status))) ? 'running' : native.every(run => run.agents.every(agent => subagentIsTerminal(agent.status))) ? 'completed' : 'unknown' : active > 0 ? 'running' : workflows.every(run => workflowIsTerminal(run.status)) ? 'completed' : 'unknown' }),
        h('span', { className: 'codingns-subagents__grouptitle' }, t(kind === 'workflow' ? 'workflow.badgeCount' : 'agent.nativeCount', { count })),
        h(Chevron, { open: kind === 'native' ? nativeOpen : workflowOpen })),
      h('div', { hidden: !(kind === 'native' ? nativeOpen : workflowOpen), className: 'codingns-subagents__runlist' }, ...items.map(run => h(ZcodeSubagentCard, { key: run.id, run, t, ...(onOpenAgent === undefined ? {} : { onOpenAgent }) }))))
  return h('div', { className: 'codingns-subagents__overview' }, group('native', native, native.reduce((sum, run) => sum + run.agents.length, 0)), group('workflow', workflows, workflows.length))
}

type WorkflowProps = { rpc: CodingNsRpcClient; sessionId: string; locale: CodingNsLocale }
const dialogListeners = new Set<() => void>()
let activeDialog: { sessionId: string; root: Root; container: HTMLElement } | undefined
const subscribeDialog = (listener: () => void): (() => void) => { dialogListeners.add(listener); return () => { dialogListeners.delete(listener) } }
const readDialogSession = (): string => activeDialog?.sessionId ?? ''
function closeWorkflowDialog(): void {
  const current = activeDialog
  if (!current) return
  activeDialog = undefined
  for (const listener of dialogListeners) listener()
  queueMicrotask(() => { current.root.unmount(); current.container.remove() })
}
function openWorkflowDialog(props: WorkflowProps): void {
  if (activeDialog?.sessionId === props.sessionId) { activeDialog.container.querySelector<HTMLDialogElement>('dialog')?.focus(); return }
  closeWorkflowDialog()
  const container = document.createElement('div')
  container.dataset.codingnsWorkflowDialog = props.sessionId
  document.body.appendChild(container)
  const root = createRoot(container)
  activeDialog = { sessionId: props.sessionId, root, container }
  root.render(h(WorkflowDialog, props))
  for (const listener of dialogListeners) listener()
}

function useSubagentState(rpc: CodingNsRpcClient, sessionId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ZcodeSubagentSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [checked, setChecked] = useState('')
  const refresh = useRef<() => void>(() => undefined)
  const rpcRef = useRef(rpc); rpcRef.current = rpc
  useEffect(() => {
    setSnapshot(null); setError(''); setChecked(''); setBusy(false)
    if (!enabled) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, pending = false
    const load = async (): Promise<void> => {
      if (pending || controller.signal.aborted || document.hidden) return
      pending = true; setBusy(true); clearTimeout(timer)
      try {
        const value = await callCliRpc<ZcodeSubagentSnapshot>(rpcRef.current, 'subagent/state', { sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
        if (controller.signal.aborted) return
        setSnapshot(value); setError(''); setChecked(new Date().toLocaleTimeString())
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)) }
      finally { pending = false; if (!controller.signal.aborted) { setBusy(false); timer = setTimeout(() => { void load() }, 3000) } }
    }
    refresh.current = () => { void load() }
    const trigger = (): void => { void load() }
    document.addEventListener('visibilitychange', trigger); trigger()
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', trigger); refresh.current = () => undefined }
  }, [sessionId, enabled])
  return { snapshot, error, busy, checked, refresh }
}

function activeAgentCount(snapshot: ZcodeSubagentSnapshot | null): number {
  return snapshot?.runs.filter(run => run.kind === 'native').reduce((total, run) => total + run.agents.filter(agent => subagentIsActive(agent.status)).length, 0) ?? 0
}

/**
 * 会话头触发器：有子代理（含刚跑完的）就出现，运行中显示脉冲点。
 *
 * 这里刻意**不**用「适配器缓存 == zcode」决定成败：
 * `replaceSessionAdapters()` 会用 Host 的一次快照整体替换缓存，替换窗口内该会话
 * 可能短暂缺失，于是入口会时有时无（实测同一页面重复加载出现 false→true 抖动）。
 * 适配器只作为"要不要省下一次 RPC"的提示；是否 ZCode 由 Host 侧
 * `subagent/state` 的绑定校验回答（未绑定时立刻返回 not-zcode，不读库）。
 */
function SubagentSlot(props: WorkflowProps): ReactElement | null {
  const { rpc, sessionId, locale } = props
  const t = useCodingNsTranslator(locale), adapter = useSyncExternalStore(subscribeSessionAdapters, () => sessionAdapterId(sessionId))
  const openSession = useSyncExternalStore(subscribeDialog, readDialogSession)
  const { snapshot, error } = useSubagentState(rpc, sessionId, adapter === undefined || adapter === 'zcode')
  useEffect(() => {
    if (adapter !== undefined) return
    const controller = new AbortController()
    void callCliRpc<{ adapterId: string }>(rpc, 'session/get', { sessionId }, controller.signal).then(v => { if (!controller.signal.aborted) publishSessionAdapter(sessionId, v.adapterId) }).catch(() => undefined)
    return () => controller.abort()
  }, [rpc, sessionId, adapter])
  const total = snapshot?.runs.reduce((count, run) => count + run.agents.length, 0) ?? 0
  const running = activeAgentCount(snapshot)
  // 只看数据：适配器缓存抖动不再决定入口存亡；非 ZCode 会话由 Host 返回空快照。
  const workflows = snapshot?.runs.filter(run => run.kind === 'workflow').length ?? 0
  const native = snapshot?.runs.filter(run => run.kind === 'native').reduce((count, run) => count + run.agents.length, 0) ?? 0
  const active = running > 0 || snapshot?.runs.some(run => run.kind === 'workflow' && workflowIsActive(run.status)) === true
  const label = [native > 0 ? t('agent.nativeCount', { count: native }) : '', workflows > 0 ? t('workflow.badgeCount', { count: workflows }) : ''].filter(Boolean).join(' · ')
  if (total === 0 && workflows === 0) return null
  return h('button', { type: 'button', onClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); if (openSession === sessionId) closeWorkflowDialog(); else openWorkflowDialog(props) }, title: label, 'aria-label': label, 'aria-expanded': openSession === sessionId,
    'aria-haspopup': 'dialog', 'data-codingns-subagent-trigger': true, className: 'codingns-workflow-trigger' },
    h('span', { className: 'codingns-workflow-activity', 'aria-hidden': true }, active
      ? h('span', { className: 'codingns-workflow-dot' }, h(StatusIcon, { status: 'running' }))
      : h('svg', { className: 'codingns-workflow-compact-icon', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }, h('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87' }), h('circle', { cx: 9, cy: 7, r: 4 }))),
    h('span', { className: 'codingns-workflow-count' }, label, error === '' ? '' : ' !'), h(Chevron, { open: openSession === sessionId }))
}

/** Non-modal overview follows the native subagent menu; details keep a full dialog. */
function WorkflowMenu({ sessionId, children, onClose, wide = false }: { sessionId: string; children?: import('react').ReactNode; onClose: () => void; wide?: boolean }): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    const opener = document.activeElement as HTMLElement | null
    const trigger = () => [...document.querySelectorAll<HTMLElement>('[data-codingns-subagent-trigger]')].find(element => element.closest('[data-session-id]')?.getAttribute('data-session-id') === sessionId) ?? document.querySelector<HTMLElement>('[data-codingns-subagent-trigger][aria-expanded=true]')
    const place = () => {
      const anchor = trigger()?.getBoundingClientRect()
      const width = Math.min(wide ? 960 : 480, window.innerWidth - 16)
      const left = Math.max(8, Math.min(anchor ? anchor.right - width : (window.innerWidth - width) / 2, window.innerWidth - width - 8))
      panel.style.width = `${width}px`; panel.style.left = `${left}px`
      panel.style.top = `${Math.max(8, Math.min(anchor ? anchor.bottom + 8 : 64, window.innerHeight - 160))}px`
      panel.style.maxHeight = `calc(100dvh - ${panel.style.top} - 8px)`
    }
    panel.show(); place(); panel.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!document.querySelector('dialog:modal') && !panel.contains(event.target as Node) && !trigger()?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog:modal')) { event.preventDefault(); event.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); panel.close(); if (opener?.isConnected) opener.focus() }
  }, [sessionId, onClose, wide])
  return h('dialog', { ref, tabIndex: -1, 'data-dsh-automatic-focus': true, className: 'codingns-subagents codingns-subagents-menu', 'aria-labelledby': `codingns-subagent-${sessionId}` }, children)
}

/** Separate React root: the native composer may rebuild its slot while a turn streams. */
function WorkflowDialog({ rpc, sessionId, locale }: WorkflowProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const { snapshot, error, busy, checked, refresh } = useSubagentState(rpc, sessionId, true)
  const [agent, setAgent] = useState<string | null>(null)
  const content = [
    h('header', { key: 'head', className: 'codingns-subagents__dialoghead' },
      h('h2', { id: `codingns-subagent-${sessionId}`, className: 'codingns-subagents__dialogtitle' }, t('agent.panelTitle')),
      h('button', { type: 'button', className: 'codingns-subagents__button', disabled: busy, onClick: () => refresh.current() }, t(busy ? 'workflow.refreshing' : 'workflow.refresh')),
      h('button', { type: 'button', className: 'codingns-subagents__button', onClick: closeWorkflowDialog }, t('workflow.close'))),
    h('div', { key: 'content', className: 'codingns-subagents__dialogcontent' },
      h('main', { hidden: agent !== null, className: 'codingns-subagents__dialogbody' },
        h('div', { className: 'codingns-subagents__toolbar' }, h('p', null, t('agent.autoRefresh')), checked === '' ? null : h('p', null, t('workflow.checked', { time: checked }))),
        error === '' ? null : h('div', { role: 'alert', className: 'codingns-subagents__disabled' }, snapshot ? t('workflow.stale') : '', h('div', null, error)),
        snapshot !== null && !snapshot.available ? h('p', { 'data-codingns-subagent-unavailable': snapshot.reason ?? '' }, t(`workflow.${snapshot.reason ?? 'database-missing'}`)) : null,
        snapshot?.available === true && snapshot.runs.length === 0 ? h('p', null, t('agent.empty')) : null,
        h(ZcodeSubagentOverview, { runs: snapshot?.runs ?? [], t, onOpenAgent: setAgent }),
        snapshot?.hasMore === true ? h('p', { className: 'codingns-subagents__note' }, t('workflow.more')) : null))]
  // Keep overview mounted while viewing progress, preserving manual folds and scroll.
  return h('div', null,
    h('div', { hidden: agent !== null }, h(WorkflowMenu, { sessionId, onClose: closeWorkflowDialog, wide: snapshot?.runs.some(run => run.kind === 'workflow') === true }, ...content)),
    agent === null ? null : h(CliSettingsDialog, { titleId: `codingns-subagent-detail-${sessionId}`, wide: true, className: 'codingns-subagents codingns-subagents-dialog', onClose: () => setAgent(null) },
      h('header', { className: 'codingns-subagents__dialoghead' }, h('h2', { id: `codingns-subagent-detail-${sessionId}`, className: 'codingns-subagents__dialogtitle' }, t('workflow.actorProgress')), h('button', { type: 'button', className: 'codingns-subagents__button', onClick: () => setAgent(null) }, t('agent.back')), h('button', { type: 'button', className: 'codingns-subagents__button', onClick: closeWorkflowDialog }, t('workflow.close'))),
      h('div', { className: 'codingns-subagents__dialogcontent' }, h('main', { className: 'codingns-subagents__dialogbody' }, h(AgentProgress, { rpc, sessionId, agentId: agent, t })))))
}
export function registerZcodeWorkflowUi(services: CodingNsClientServices): () => void {
  if (!services.slots) return () => undefined
  installWorkflowHeaderStyles()
  const slots = services.slots as unknown as { inject(name: string, callback: () => () => void): () => void; register(options: Record<string, unknown>, component: typeof SubagentSlot): () => void }
  const dispose = slots.inject('conversation.session.header.actions', () => slots.register({ name: 'conversation.session.header.actions', id: 'codingns-zcode-subagents', order: 11, label: 'ZCode subagents', inject: (sessionId: string) => ({ sessionId, rpc: services.rpc, locale: services.locale }) }, SubagentSlot))
  return () => { dispose(); closeWorkflowDialog() }
}

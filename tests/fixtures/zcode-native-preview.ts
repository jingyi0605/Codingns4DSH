/** Real registered UI with deterministic, local-only sample data. No agent is started. */
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { registerZcodeWorkflowUi } from '../../src/client/zcode-workflow.js'
import { publishSessionAdapter } from '../../src/client/session-adapter-cache.js'
import { zh } from '../../src/client/locales/zcodeWorkflow.js'
import type { ZcodeSubagentRun, ZcodeSubagentSummary } from '../../src/shared/contracts/zcode-subagent.js'

const now = 1794800000000
const base: ZcodeSubagentSummary = { id: '', origin: 'native', title: '', status: 'running', subagentType: '', model: 'GLM-5.3-Flash', createdAt: now, updatedAt: now + 300000, runId: '', activityId: '', phase: '', callPath: '', prompt: '', result: '', error: '', tokens: null, durationMs: 300000, artifacts: [] }
const native: ZcodeSubagentRun = {
  id: 'native-demo', kind: 'native', name: '', status: 'running', createdAt: now, updatedAt: now + 1669000, currentPhase: '', tokens: 9200000, result: '', error: '', resumedFrom: '', phases: [], artifacts: [], truncated: false,
  agents: [
    { ...base, id: 'native-1', title: '独立审阅：核对状态链与边界条件', prompt: '检查运行状态、结束通知及历史记录的一致性', tokens: 7700000, durationMs: 1669000 },
    { ...base, id: 'native-2', title: '交叉复核：验证修复与回归结果', prompt: '复查关键改动，核对构建与回归结果', tokens: 1500000, durationMs: 346000 },
    ...['核对接口契约', '检查错误恢复路径', '验证手机布局', '复查产物记录', '整理最终审查报告'].map((title, index) => ({ ...base, id: `ended-${index}`, title, status: (index === 3 ? 'interrupted' : 'completed') as ZcodeSubagentSummary['status'], result: index === 3 ? '' : '已完成检查，报告已返回主会话', tokens: 320000 + index * 100000, durationMs: 115000 + index * 20000 })),
  ],
}
const actors = [
  { ...base, id: 'actor-1', origin: 'workflow' as const, title: '核对数据读取与状态映射', prompt: '检查工作流与子智能体的状态来源', phase: 'review', tokens: 880000, durationMs: 245000 },
  { ...base, id: 'actor-2', origin: 'workflow' as const, title: '验证桌面与窄屏交互', status: 'completed' as const, result: '桌面与手机尺寸均无横向溢出', phase: 'review', tokens: 640000, durationMs: 189000 },
  { ...base, id: 'actor-3', origin: 'workflow' as const, title: '交叉审阅：检查状态边界与错误恢复', prompt: '独立核对失败、中断和恢复路径', phase: 'review', tokens: 520000, durationMs: 176000 },
  { ...base, id: 'actor-4', origin: 'workflow' as const, title: '核对产物记录与任务归属', status: 'completed' as const, result: '产物记录和归属检查完成', phase: 'review', tokens: 410000, durationMs: 142000 },
  { ...base, id: 'actor-5', origin: 'workflow' as const, title: '整理回归结果与交付说明', status: 'completed' as const, result: '回归结果已整理', phase: 'review', tokens: 290000, durationMs: 128000 },
]
const workflow: ZcodeSubagentRun = { ...native, id: 'workflow-demo', kind: 'workflow', name: '界面一致性优化与交叉验证', tokens: actors.reduce((sum, actor) => sum + (actor.tokens ?? 0), 0), currentPhase: '并行检查', updatedAt: now + 346000, agents: actors, phases: [{ id: 'review', name: '并行检查', status: 'running', done: 3, total: actors.length }], artifacts: [] }
const history: ZcodeSubagentRun = { ...workflow, id: 'workflow-history', name: '历史工作流：接口与状态回归', status: 'completed', currentPhase: '', tokens: 2640000, updatedAt: now + 725000, agents: actors.map(actor => ({ ...actor, id: `${actor.id}-history`, status: 'completed' })), result: '接口与状态回归通过。', phases: [{ id: 'review', name: '并行检查', status: 'completed', done: actors.length, total: actors.length }] }
let mode = new URLSearchParams(location.search).get('mode') ?? 'both'
let selected: ZcodeSubagentSummary = native.agents[0]!
let registration: any
const snapshot = () => ({ available: true, reason: null, hasMore: false, runs: mode === 'native' ? [native] : mode === 'workflow' ? [workflow, history] : [native, workflow, history] })
const requests: string[] = []
const rpc = { call: async (_channel: string, endpoint: string, payload: any) => {
  requests.push(endpoint)
  if (endpoint.endsWith('session/get')) return { ok: true, value: { adapterId: 'zcode' } }
  if (endpoint.endsWith('subagent/agent')) {
    selected = [...native.agents, ...actors, ...history.agents].find(agent => agent.id === payload.agentId) ?? selected
    return { ok: true, value: { agent: selected, entries: [{ id: 'entry-1', messageId: 'message-1', role: 'assistant', time: now + 200000, text: '正在核对任务状态与界面展示。当前进度会在此处持续更新。', name: '', status: '', input: '', error: '', truncated: false }], nextCursor: null } }
  }
  return { ok: true, value: snapshot() }
} }
const locale = { bind: () => (key: string, args: Record<string, unknown> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(args[name] ?? '')), subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }) }
const dispose = registerZcodeWorkflowUi({ locale, rpc, slots: { inject: (_: string, mount: () => void) => mount(), register: (options: any, component: any) => { registration = { options, component }; return () => undefined } } } as never)
publishSessionAdapter('preview-session', 'zcode')
const root = createRoot(document.querySelector('#root')!)
function Preview() {
  return h('header', { className: 'preview-session', 'data-session-id': 'preview-session' }, h('span', null, '界面一致性优化'), h(registration.component, registration.options.inject('preview-session')))
}
root.render(h(Preview))
const refresh = () => document.dispatchEvent(new Event('visibilitychange'))
Object.assign(window, { preview: { requests, native, workflow, history, dispose, refresh, setMode: (value: string) => { mode = value; refresh() } } })
document.querySelectorAll<HTMLElement>('[data-preview-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.previewMode!; refresh()
  document.querySelectorAll('[data-preview-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
}))
document.querySelector('[data-preview-theme]')?.addEventListener('click', () => document.body.toggleAttribute('data-ds-dark-theme'))
const timer = setInterval(() => { const trigger = document.querySelector<HTMLButtonElement>('[data-codingns-subagent-trigger]'); if (trigger) { clearInterval(timer); trigger.click() } }, 50)

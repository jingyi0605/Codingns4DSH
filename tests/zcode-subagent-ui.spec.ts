import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ZcodeSubagentCard, ZcodeSubagentOverview, agentSteps, agentSummaryLine } from '../data/build/dist/client/zcode-workflow.js'
import { formatAgentDuration, formatAgentTokens, mergeSubagentEntries } from '../data/build/dist/client/zcode-agent.js'
import type { ZcodeSubagentRun } from '../data/build/dist/shared/contracts/zcode-subagent.js'
import { zh } from '../data/build/dist/client/locales/zcodeWorkflow.js'

const t = ((key: string, args: Record<string, unknown> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(args[name] ?? ''))) as never

test('workflow 仅在进行中默认展开，结束或未知状态默认折叠', () => {
  for (const status of ['completed', 'cancelled', 'failed', 'interrupted', 'stopped', 'unknown']) {
    const html = renderToStaticMarkup(createElement(ZcodeSubagentCard, { run: run({ status }), t }))
    assert.ok(html.includes('aria-expanded="false"'), `${status} should start collapsed`)
    assert.ok(!html.includes('data-codingns-agent-step='), `${status} should hide steps`)
  }
  for (const status of ['running', 'pending', 'queued', 'waiting', 'executing', 'created', 'dispatched', 'in_progress', 'starting', 'resuming', 'stalled']) {
    const html = renderToStaticMarkup(createElement(ZcodeSubagentCard, { run: run({ status }), t }))
    assert.ok(html.includes('aria-expanded="true"'), `${status} should start expanded`)
  }
})

function agent(overrides: Partial<ZcodeSubagentRun['agents'][number]> = {}): ZcodeSubagentRun['agents'][number] {
  return {
    id: 'wf:run-1:act-1', origin: 'workflow', title: '并行诊断三项根因', status: 'completed', subagentType: '', model: 'account:test/GLM-5.3-Flash',
    createdAt: 30, updatedAt: 55, runId: 'run-1', activityId: 'act-1', phase: 'phase-a', callPath: 'dwf/run/actor#1', prompt: '诊断根因', result: '根因已定位',
    error: '', tokens: 3500, durationMs: 25_000, artifacts: [{ id: 'a', name: 'workflow-report.md', kind: 'md', time: 40, agentId: 'wf:run-1:act-1' }], ...overrides,
  }
}

function run(overrides: Partial<ZcodeSubagentRun> = {}): ZcodeSubagentRun {
  return {
    id: 'dwfrun-1', kind: 'workflow', name: '示例：构建与验证', status: 'completed', createdAt: 29, updatedAt: 80, currentPhase: '轮 A',
    tokens: 4400, result: '', error: '', resumedFrom: '',
    agents: [agent(), agent({ id: 'wf:run-1:act-2', title: '实现修复与构建门', status: 'failed', activityId: 'act-2', phase: 'phase-b', callPath: 'dwf/run/actor#2', error: '构建失败', artifacts: [] })],
    artifacts: [{ id: 'a', name: 'workflow-report.md', kind: 'md', time: 40, agentId: 'wf:run-1:act-1' }],
    phases: [{ id: 'phase-a', name: '诊断', status: 'completed', done: 1, total: 1 }, { id: 'phase-b', name: '修复', status: 'completed', done: 1, total: 1 }],
    truncated: false, ...overrides,
  }
}

test('DSH 风格运行卡片保留状态、参与者摘要、步骤与产物，失败不计入完成', () => {
  const html = renderToStaticMarkup(createElement(ZcodeSubagentCard, { run: run(), t, defaultOpen: true }))
  for (const label of ['示例：构建与验证', '已完成', '2 位参与者 · 1/2 已完成 · 4.4K tokens · 1 个产物', '诊断', '修复', 'workflow-report.md', 'MD', 'data-codingns-subagent-run="dwfrun-1"']) {
    assert.ok(html.includes(label), label)
  }
  assert.ok(html.includes('data-codingns-agent-step-count="0/1"'), '失败步骤不算成功完成')
  assert.ok(!/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/u.test(html), '没有嵌套按钮')
})

test('步骤树按阶段归位参与者，未归位的参与者单独成行且摘要不用 0 冒充用量', () => {
  const steps = agentSteps(run())
  assert.deepEqual(steps.map(step => step.label), ['诊断', '修复'])
  assert.deepEqual(steps.map(step => step.agents.length), [1, 1])
  const orphan = run({ phases: [{ id: 'phase-a', name: '诊断', status: 'completed', done: 1, total: 1 }, { id: 'phase-b', name: '修复', status: 'completed', done: 1, total: 1 }], agents: [agent({ phase: 'phase-missing' })] })
  assert.deepEqual(agentSteps(orphan).map(step => step.label), ['并行诊断三项根因'], '未归位的参与者单独成行，空阶段不占位')
  const noTokens = run({ tokens: null })
  assert.equal(agentSummaryLine(noTokens, t), '2 位参与者 · 1/2 已完成 · 1 个产物')
  const native = run({ kind: 'native', name: '', agents: [agent({ origin: 'native', id: 'sa:sess_1', status: 'running' })], phases: [] })
  const nativeHtml = renderToStaticMarkup(createElement(ZcodeSubagentCard, { run: native, t }))
  assert.ok(!nativeHtml.includes('子代理任务（1）'), '子智能体直接列出，不重复包装任务标题')
  assert.ok(nativeHtml.includes('data-codingns-agent-row="sa:sess_1"'), '普通子代理直接显示任务行')
  assert.ok(!nativeHtml.includes('data-codingns-agent-step='), '普通子代理不伪装成 workflow 阶段')
})

test('混合快照按类型分区，活动工作流优先且不受已结束参与者影响', () => {
  const runs = [run({ id: 'old', status: 'completed', createdAt: 30 }), run({ id: 'active', status: 'running', createdAt: 1, agents: [agent()] }), run({ id: 'native', kind: 'native', phases: [], agents: [agent({ id: 'sa:native', origin: 'native' })] })]
  const html = renderToStaticMarkup(createElement(ZcodeSubagentOverview, { runs, t }))
  assert.ok(html.includes('data-codingns-subagent-group="workflow"'))
  assert.ok(html.includes('data-codingns-subagent-group="native"'))
  assert.ok(html.indexOf('data-codingns-subagent-run="active"') < html.indexOf('data-codingns-subagent-run="old"'))
  assert.ok(html.includes('1 个子智能体'))
  assert.deepEqual(runs.map(item => item.id), ['old', 'active', 'native'], '排序不改写 RPC 快照')
  const unknown = renderToStaticMarkup(createElement(ZcodeSubagentOverview, { runs: [run({ status: 'unknown' })], t }))
  assert.ok(!unknown.includes('全部已结束'), '未知状态不能冒充已结束')
})

test('终态子智能体折叠，未知状态仍可见，缺失用量不冒充零', () => {
  const html = renderToStaticMarkup(createElement(ZcodeSubagentCard, { run: run({ kind: 'native', agents: [agent({ id: 'unknown-child', origin: 'native', status: 'unknown', tokens: null }), agent({ id: 'done-child', origin: 'native', status: 'completed' }), agent({ id: 'failed-child', origin: 'native', status: 'failed' })] }), t }))
  assert.ok(html.includes('data-codingns-agent-row="unknown-child"'))
  assert.ok(html.includes('未知'))
  assert.ok(html.includes('未记录用量'))
  assert.ok(!html.includes('0 tok'))
  assert.ok(html.includes('已结束 2 个子智能体'))
  assert.ok(!html.includes('data-codingns-agent-row="done-child"'))
  assert.ok(!html.includes('data-codingns-agent-row="failed-child"'))
  assert.ok(html.includes('data-codingns-artifact='), '原有产物信息保留在可展开区域')
})

test('token 与时长使用项目统一的紧凑格式，未记录用量不显示为 0', () => {
  assert.equal(formatAgentTokens(999), '999')
  assert.equal(formatAgentTokens(3500), '3.5K')
  assert.equal(formatAgentTokens(44_400), '44K')
  assert.equal(formatAgentTokens(4_400_000), '4.4M')
  assert.equal(formatAgentTokens(null), '')
  assert.equal(formatAgentDuration(12_000), '12s')
  assert.equal(formatAgentDuration(125_000), '2m 5s')
  assert.equal(formatAgentDuration(3_725_000), '1h 2m')
  assert.equal(formatAgentDuration(-1), '—')
})

test('参与者时间线按 ID 去重合并，流式更新不重复条目', () => {
  const base = { messageId: 'm', role: 'tool' as const, name: 'Write', status: 'running', input: '{}', error: '', truncated: false }
  const entries = mergeSubagentEntries(
    [{ ...base, id: 'current', time: 2, text: 'partial' }],
    [{ ...base, id: 'current', time: 2, status: 'completed', text: 'done' }, { ...base, id: 'old', time: 1, text: 'earlier' }],
  )
  assert.deepEqual(entries.map(entry => [entry.id, entry.text]), [['old', 'earlier'], ['current', 'done']])
})

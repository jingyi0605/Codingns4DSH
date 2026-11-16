import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readZcodeSubagentDetail, readZcodeSubagents } from '../data/build/dist/host/cli-adapters/zcode-subagent.js'
import { ZcodeSubagentService } from '../data/build/dist/host/cli-adapters/zcode-subagent-service.js'
import { normalizeSubagentStatus } from '../data/build/dist/shared/contracts/zcode-subagent.js'

const PARENT = 'sess_parent'

/**
 * 夹具复刻真实 ZCode 库（2026-11-15 核对）：
 * 工作流在 `dwf_run` / `dwf_actor` / `dwf_node`，内建子代理在 `session.task_type='subagent_child'`。
 * `workflow_run` / `workflow_activity` 在本代是空表，刻意不建，防止读取器再退回旧表。
 */
function fixture(): { path: string; db: DatabaseSync } {
  const path = join(mkdtempSync(join(tmpdir(), 'zcode-subagent-')), 'fixture.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, task_type TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, last_outcome TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, started_at INTEGER);
    CREATE TABLE dwf_run(id TEXT PRIMARY KEY, parent_session_id TEXT, cwd TEXT, name TEXT, status TEXT, spent_tokens INTEGER, resumed_from TEXT, result_json TEXT, failure_json TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE dwf_actor(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, site_id TEXT, ordinal INTEGER, name TEXT, resolved_model TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE dwf_node(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, site_id TEXT, ordinal INTEGER, kind TEXT, actor_site_id TEXT, actor_ordinal INTEGER, actor_seq INTEGER, input_json TEXT, status TEXT, result_json TEXT, error_json TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session VALUES('${PARENT}',NULL,'interactive','父会话','D:/work',1,99,'completed');
    INSERT INTO session VALUES('sess_native_1','${PARENT}','subagent_child','子代理：检查 subagent_type: "Explore" 的只读任务','D:/work',10,20,'completed');
    INSERT INTO session VALUES('sess_wf_1','${PARENT}','workflow_child','workflow subagent actor#1@1','D:/work',30,60,'completed');
    INSERT INTO session VALUES('sess_wf_2','${PARENT}','workflow_child','workflow subagent actor#2@1','D:/work',61,70,'error');
    INSERT INTO session VALUES('sess_other_parent','sess_unrelated','subagent_child','其它会话的子代理','D:/other',5,6,'completed');
    INSERT INTO dwf_run VALUES('dwfrun-1','${PARENT}','D:/work','示例：构建与验证','completed',4400,'dwfrun-0',NULL,NULL,29,80);
    INSERT INTO dwf_actor VALUES(1,'dwfrun-1','actor#1',1,'修复员','account:test/GLM-5.3-Flash','sess_wf_1',30,55);
    INSERT INTO dwf_actor VALUES(2,'dwfrun-1','actor#2',1,'复测员·第 1 轮','account:test/GLM-5.3-Flash','sess_wf_2',61,70);
    INSERT INTO dwf_actor VALUES(3,'dwfrun-1','actor#3',1,'撰写员',NULL,NULL,58,58);
    INSERT INTO dwf_node VALUES(1,'dwfrun-1','ask#1',1,'ask','actor#1',1,1,'{"label":"并行诊断三项根因"}','completed','"根因已定位"',NULL,30,55);
    INSERT INTO dwf_node VALUES(2,'dwfrun-1','ask#2',1,'ask','actor#2',1,1,'{"label":"实现修复与构建门"}','failed',NULL,'{"message":"构建失败"}',61,70);
    INSERT INTO dwf_node VALUES(3,'dwfrun-1','report#1',1,'report','actor#3',1,1,'{"label":"撰写收尾报告"}','completed','"报告已交付"',NULL,58,58);
    INSERT INTO model_usage VALUES('u1','sess_native_1','account:test','GLM-5.3-Flash',1000,500,0,0,11);
    INSERT INTO model_usage VALUES('u2','sess_wf_1','account:test','GLM-5.3-Flash',2000,1000,500,0,31);
  `)
  const message = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)')
  const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)')
  message.run('m-native-1', 'sess_native_1', 11, 11, JSON.stringify({ role: 'assistant' }))
  part.run('p-native-1', 'm-native-1', 'sess_native_1', 11, 11, JSON.stringify({ type: 'text', text: 'SUBAGENT-OK-42' }))
  part.run('p-native-2', 'm-native-1', 'sess_native_1', 12, 12, JSON.stringify({ type: 'text', text: 'injected context', synthetic: true }))
  message.run('m-native-hidden', 'sess_native_1', 13, 13, JSON.stringify({ role: 'user', semantics: { uiVisibility: 'hidden' } }))
  part.run('p-native-3', 'm-native-hidden', 'sess_native_1', 13, 13, JSON.stringify({ type: 'text', text: 'hidden model context' }))
  message.run('m-wf-1', 'sess_wf_1', 31, 31, JSON.stringify({ role: 'assistant' }))
  part.run('p-wf-1', 'm-wf-1', 'sess_wf_1', 31, 31, JSON.stringify({ type: 'text', text: '报告已写入 reports/2026-11-15-a6700-报告.md' }))
  part.run('p-wf-2', 'm-wf-1', 'sess_wf_1', 32, 32, JSON.stringify({ type: 'tool', tool: 'Write', state: { status: 'completed', input: { file_path: 'E:/work/reports/workflow-report.md' }, output: 'ok' } }))
  part.run('p-wf-3', 'm-wf-1', 'sess_wf_1', 33, 33, JSON.stringify({ type: 'tool', tool: 'Read', state: { status: 'completed', input: { file_path: 'E:/work/secret.bin' }, output: 'noise' } }))
  part.run('p-wf-4', 'm-wf-1', 'sess_wf_1', 34, 34, JSON.stringify({ type: 'tool', tool: 'Bash', state: { status: 'error', error: 'build gate failed' } }))
  return { path, db }
}

test('工作流参与者来自 dwf_actor，节点提供步骤名/结果，内建子代理单独分组', () => {
  const { path, db } = fixture()
  try {
    const snapshot = readZcodeSubagents(path, [PARENT])
    assert.equal(snapshot.available, true)
    assert.deepEqual(snapshot.runs.map(run => run.id), ['dwfrun-1', `native:${PARENT}`])
    const workflow = snapshot.runs[0]!
    assert.equal(workflow.kind, 'workflow')
    assert.equal(workflow.name, '示例：构建与验证')
    assert.deepEqual(workflow.agents.map(agent => agent.title), ['修复员', '复测员·第 1 轮', '撰写员'])
    assert.deepEqual(workflow.agents.map(agent => agent.status), ['completed', 'failed', 'completed'])
    assert.equal(workflow.agents[0]?.prompt, '并行诊断三项根因')
    assert.equal(workflow.agents[0]?.result, '根因已定位')
    assert.match(workflow.agents[1]?.error ?? '', /构建失败/u, '节点失败原因透传为可读文本')
    assert.equal(workflow.agents[1]?.model, 'account:test/GLM-5.3-Flash')
    assert.equal(workflow.agents[0]?.tokens, 3500)
    assert.equal(workflow.tokens, 4400, 'run 自带 spent_tokens 优先')
    assert.equal(workflow.resumedFrom, 'dwfrun-0')
    assert.deepEqual(workflow.phases.map(phase => phase.name), ['并行诊断三项根因', '实现修复与构建门', '撰写收尾报告'], '没有阶段图时按节点顺序分组并沿用步骤名')
    assert.deepEqual(workflow.agents[0]?.artifacts.map(artifact => artifact.name), ['workflow-report.md'])
    const native = snapshot.runs[1]!
    assert.equal(native.kind, 'native')
    assert.equal(native.agents[0]?.subagentType, 'Explore')
    assert.equal(native.agents[0]?.result, 'SUBAGENT-OK-42')
    assert.equal(native.agents[0]?.tokens, 1500)
    assert.equal(readZcodeSubagents(path, ['sess_unrelated']).runs.length, 1, '其它父会话只能看到自己的子代理')
    assert.equal(readZcodeSubagents(path, ['sess_other_parent']).runs.length, 0, '子会话自己的子代理不会混进父会话视图')
    assert.ok(!JSON.stringify(snapshot).includes('其它会话的子代理'))
  } finally { db.close() }
})

test('正文时间线过滤合成与隐藏上下文，工具与失败原因可读且可分页', () => {
  const { path, db } = fixture()
  try {
    const snapshot = readZcodeSubagents(path, [PARENT])
    const nativeId = snapshot.runs[1]!.agents[0]!.id
    const native = readZcodeSubagentDetail(path, [PARENT], nativeId)
    assert.deepEqual(native.entries.map(entry => entry.text), ['SUBAGENT-OK-42'])
    assert.ok(!JSON.stringify(native).includes('hidden model'))
    assert.ok(!JSON.stringify(native).includes('injected context'))
    const workflowId = snapshot.runs[0]!.agents[0]!.id
    const detail = readZcodeSubagentDetail(path, [PARENT], workflowId)
    assert.deepEqual(detail.entries.map(entry => entry.role), ['assistant', 'tool', 'tool', 'tool'])
    assert.equal(detail.entries[1]?.name, 'Write')
    assert.equal(detail.entries[2]?.name, 'Read')
    assert.equal(detail.entries[3]?.name, 'Bash')
    assert.equal(detail.entries[3]?.error, 'build gate failed')
    assert.equal(detail.nextCursor, null)
    const noSession = snapshot.runs[0]!.agents[2]!
    assert.deepEqual(readZcodeSubagentDetail(path, [PARENT], noSession.id).entries, [], '没有子会话的参与者返回空时间线')
    assert.throws(() => readZcodeSubagentDetail(path, [PARENT], 'wf:dwfrun-1:missing'), /does not belong/u)
    assert.throws(() => readZcodeSubagentDetail(path, [PARENT], 'evil; DROP TABLE session'), /Invalid subagent request/u)
  } finally { db.close() }
})

test('缺库、缺表与未绑定会话都给出明确原因，且从不写入原生库', () => {
  const { path, db } = fixture()
  try {
    assert.equal(readZcodeSubagents(`${path}.missing`, [PARENT]).reason, 'database-missing')
    db.exec('DROP TABLE dwf_node')
    assert.equal(readZcodeSubagents(path, [PARENT]).reason, 'schema-unsupported')
    assert.equal(readZcodeSubagents(path, [PARENT]).runs.length, 0)
  } finally { db.close() }
  const { path: path2, db: db2 } = fixture()
  try {
    const before = db2.prepare('SELECT count(*) AS n FROM part').get()?.n
    readZcodeSubagents(path2, [PARENT])
    assert.equal(db2.prepare('SELECT count(*) AS n FROM part').get()?.n, before)
  } finally { db2.close() }
})

test('RPC 只接受 DSH 会话绑定，游标与参与者标识越界直接拒绝', async () => {
  const { path, db } = fixture()
  try {
    const store = { get: (id: string) => id === 'bound' ? { adapterId: 'zcode', providerSessionId: PARENT, dshSessionId: id } : id === 'other' ? { adapterId: 'codex', providerSessionId: PARENT, dshSessionId: id } : undefined }
    const service = new ZcodeSubagentService(store as never, path)
    const snapshot = await service.read({ sessionId: 'bound', providerSessionId: 'attacker' })
    assert.equal(snapshot.runs.length, 2)
    assert.equal((await service.read({ sessionId: 'missing' })).reason, 'not-zcode')
    assert.equal((await service.read({ sessionId: 'other' })).reason, 'not-zcode')
    const agentId = snapshot.runs[1]!.agents[0]!.id
    assert.equal((await service.readAgent({ sessionId: 'bound', agentId })).entries.length, 1)
    await assert.rejects(() => service.readAgent({ sessionId: 'bound', agentId, cursor: { beforeTime: -1, beforeId: 'x' } }), /Invalid subagent history cursor/u)
    await assert.rejects(() => service.readAgent({ sessionId: 'bound', agentId: '' }), /缺少子代理标识/u)
    await assert.rejects(() => service.readAgent({ sessionId: 'other', agentId }), /请选择一个 ZCode 会话/u)
    service.dispose()
  } finally { db.close() }
})

test('三页时间线不重叠、不遗漏，缺列明确降级', () => {
  const { path, db } = fixture()
  try {
    const message = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)')
    const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)')
    for (let i = 0; i < 205; i++) {
      const id = `page-${String(i).padStart(3, '0')}`
      message.run(id, 'sess_native_1', 100, 100, JSON.stringify({ role: 'assistant' }))
      part.run(id, id, 'sess_native_1', 100, 100, JSON.stringify({ type: 'text', text: id }))
    }
    const seen: string[] = []
    let cursor: { beforeTime: number; beforeId: string } | undefined
    do {
      const page = readZcodeSubagentDetail(path, [PARENT], 'sa:sess_native_1', cursor ? { cursor } : {})
      seen.push(...page.entries.map(entry => entry.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor && seen.length < 500)
    assert.equal(seen.length, 206)
    assert.equal(new Set(seen).size, seen.length)
    db.exec('ALTER TABLE dwf_actor RENAME COLUMN name TO unsupported_name')
    assert.equal(readZcodeSubagents(path, [PARENT]).reason, 'schema-unsupported')
  } finally { db.close() }
})

test('状态归一化不把未知取值当成成功', () => {
  assert.equal(normalizeSubagentStatus('completed'), 'completed')
  assert.equal(normalizeSubagentStatus('SUCCESS'), 'completed')
  assert.equal(normalizeSubagentStatus('error'), 'failed')
  assert.equal(normalizeSubagentStatus('canceled'), 'cancelled')
  assert.equal(normalizeSubagentStatus('  Running '), 'running')
  assert.equal(normalizeSubagentStatus('mystery'), 'unknown')
  assert.equal(normalizeSubagentStatus(''), 'unknown')
})

test('普通子代理未结算且仍有更新显示运行中，旧记录保持未知', () => {
  const { path, db } = fixture()
  try {
    db.prepare('UPDATE session SET last_outcome=NULL,time_updated=? WHERE id=?').run(Date.now(), 'sess_native_1')
    assert.equal(readZcodeSubagents(path, [PARENT]).runs.find(run => run.kind === 'native')?.agents[0]?.status, 'running')
    db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(Date.now() - 16 * 60_000, 'sess_native_1')
    const stale = readZcodeSubagents(path, [PARENT]).runs.find(run => run.kind === 'native')
    assert.equal(stale?.agents[0]?.status, 'unknown')
    assert.equal(stale?.status, 'unknown', '未知的普通子代理不能让整组显示已完成')
  } finally { db.close() }
})

test('排队 workflow 无参与者也保留，活动优先且最多返回20个工作流', () => {
  const { path, db } = fixture()
  try {
    const insert = db.prepare('INSERT INTO dwf_run VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (let index = 0; index < 23; index++) insert.run(`extra-${index}`, PARENT, 'D:/work', `History ${index}`, index === 0 ? 'queued' : 'completed', 0, '', null, null, 100 + index, 200)
    const snapshot = readZcodeSubagents(path, [PARENT])
    const workflows = snapshot.runs.filter(run => run.kind === 'workflow')
    assert.equal(workflows.length, 20)
    assert.equal(workflows[0]?.id, 'extra-0')
    assert.deepEqual(workflows[0]?.agents, [])
    assert.equal(snapshot.hasMore, true)
    assert.equal(snapshot.runs.filter(run => run.kind === 'native').length, 1)
  } finally { db.close() }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/analyze-voice-diagnostics.mjs', import.meta.url))

test('新自检和新启动文件不能遮住旧文件中新写入的真实通话，轮转文件全部汇总', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-log-analysis-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const put = (name: string, record: unknown) => writeFile(join(directory, name), JSON.stringify(record) + '\n')
  await put('voice-performance-2026-10-07T01-old.0.jsonl', { timestamp: '2026-10-07T14:48:00Z', event: 'client.turn.start', fields: {} })
  await put('voice-performance-2026-10-07T01-old.1.jsonl', { timestamp: '2026-10-07T14:48:30Z', event: 'client.upload.error', fields: { pendingBytes: 130788 } })
  await put('voice-performance-2026-10-07T02-new.0.jsonl', { timestamp: '2026-10-07T14:49:00Z', event: 'diagnostics.self_test', fields: {} })
  await put('voice-performance-2026-10-07T03-start.0.jsonl', { timestamp: '2026-10-07T14:50:00Z', event: 'diagnostics.started', fields: {} })
  const output = execFileSync(process.execPath, [script, directory], { encoding: 'utf8' })
  assert.match(output, /分析 2 个文件、2 条记录/u)
  assert.match(output, /130788/u)
  assert.doesNotMatch(output, /尚无完整通话|02-new|03-start/u)
})

test('无真实日志时明确区分自检与通话，失败早于 LLM 也能给出上传诊断', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-empty-analysis-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'voice-performance-fixture.0.jsonl')
  await writeFile(file, JSON.stringify({ timestamp: '2026-10-07T14:50:00Z', event: 'diagnostics.self_test' }) + '\n')
  assert.match(execFileSync(process.execPath, [script, directory], { encoding: 'utf8' }), /仅有自检或启动记录/u)
  await writeFile(file, [
    { timestamp: '2026-10-07T14:50:00Z', event: 'client.upload.start', fields: { diagnosticId: 'failed' } },
    { timestamp: '2026-10-07T14:50:05Z', event: 'client.upload.error', fields: { diagnosticId: 'failed', code: 'upload_timeout', pendingAudioMs: 4700, inFlightMs: 5000 } },
  ].map((item) => JSON.stringify(item)).join('\n'))
  const output = execFileSync(process.execPath, [script, directory], { encoding: 'utf8' })
  assert.match(output, /upload_timeout/u); assert.match(output, /在途等待 5000/u)
  assert.match(output, /未完成上传 failed/u); assert.match(output, /启动和上传阶段的指标仍可/u)
})

test('搜索工具已注册与实际调用成功分别统计，失败不能算已取得联网信息', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-search-analysis-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'voice-performance-search.0.jsonl'), [
    { event: 'host.assistant.tools', fields: { webSearchAvailable: true, searchRegistration: 'scoped' } },
    { event: 'host.llm.tool', fields: { action: 'web_search', state: 'running' } },
    { event: 'host.llm.tool', fields: { action: 'web_search', state: 'failed' } },
  ].map((item) => JSON.stringify({ timestamp: '2026-10-07T15:40:00Z', ...item })).join('\n'))
  const output = execFileSync(process.execPath, [script, directory], { encoding: 'utf8' })
  assert.match(output, /已开放，注册方式 scoped/)
  assert.match(output, /发起 1 次，完成 0 次，失败 1 次/)
})

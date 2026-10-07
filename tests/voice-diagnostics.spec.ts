import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceDiagnosticWriter, installVoiceDiagnostics } from '../src/host/voice-diagnostics.js'
import { ClientVoiceDiagnostics } from '../src/client/voice-diagnostics.js'
import { traceVoice, subscribeVoiceDiagnostics, measureVoice } from '../src/shared/voice-diagnostics.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createCodingNsRpcHandler } from '../src/host/rpc.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { MossTtsWorker } from '../src/host/features/moss-tts-worker.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'
import { fileURLToPath } from 'node:url'

test('Host 和浏览器指标真实落盘，正文与音频被剔除，并发 flush 保持顺序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-log-'))
  const writer = new VoiceDiagnosticWriter(directory)
  try {
    writer.record({ timestamp: Date.now(), event: 'host.asr.metrics', fields: { decodeMs: 10, text: '不能保存的对话', data: '不能保存的音频', token: '密钥' } })
    writer.record({ timestamp: Date.now(), event: 'client.tts.chunk', fields: { diagnosticId: 'chunk-1', audioMs: 80 } }, 'client')
    await Promise.all([writer.flush(), writer.flush()])
    const value = await readFile(writer.filePath, 'utf8')
    assert.doesNotMatch(value, /不能保存|密钥/u)
    const records = value.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(records.map((item) => item.event), ['host.asr.metrics', 'client.tts.chunk'])
    assert.deepEqual(records[0].fields, { decodeMs: 10 })
    assert.equal(records[1].source, 'client')
  } finally { await writer.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('日志轮转仅覆盖本轮文件，队列溢出写明丢弃数量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-rotation-'))
  const writer = new VoiceDiagnosticWriter(directory, { maxFileBytes: 1, maxFiles: 2, maxPendingBytes: 600 })
  try {
    await writeFile(join(directory, 'existing.jsonl'), '原有日志')
    for (let batch = 0; batch < 5; batch++) {
      for (let sequence = 0; sequence < 10; sequence++) writer.record({ timestamp: Date.now(), event: 'host.test', fields: { sequence } })
      await writer.flush()
    }
    assert.equal((await readdir(directory)).length, 3)
    assert.equal(await readFile(join(directory, 'existing.jsonl'), 'utf8'), '原有日志')
    assert.match(await readFile(writer.filePath, 'utf8'), /diagnostics.dropped/u)
  } finally { await writer.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('诊断订阅者和磁盘异常不会让业务调用失败', async (t) => {
  const dispose = subscribeVoiceDiagnostics(() => { throw new Error('diagnostic failure') })
  try { assert.equal(await measureVoice('host.test', {}, async () => 42), 42) } finally { dispose() }
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-failure-'))
  const path = join(directory, 'ordinary-file'); await writeFile(path, '保留原文件')
  const records: unknown[][] = []
  t.mock.method(console, 'warn', (...args) => records.push(args))
  const writer = new VoiceDiagnosticWriter(path)
  try {
    writer.record({ timestamp: Date.now(), event: 'host.test', fields: {} }); await writer.flush()
    writer.record({ timestamp: Date.now(), event: 'host.test', fields: {} }); await writer.flush()
    assert.equal(records.length, 1)
    assert.equal(await readFile(path, 'utf8'), '保留原文件')
  } finally { await writer.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('Client 批量上报不并发，停止时排空剩余记录并剔除敏感字段', async () => {
  let resolve!: (value: unknown) => void
  const batches: any[] = []
  const services = { rpc: { call: async (_channel: string, endpoint: string, payload: unknown) => {
    assert.equal(endpoint, 'assistant/voice/diagnostics'); batches.push(payload)
    if (batches.length === 1) return await new Promise((finish) => { resolve = finish })
    return { ok: true, value: {} }
  } } } as unknown as CodingNsClientServices
  const diagnostics = new ClientVoiceDiagnostics(services, { ownerId: 'page', callId: 'call' })
  for (let index = 0; index < 70; index++) diagnostics.record('client.test', { sequence: index, text: '秘密' })
  assert.equal(batches.length, 1)
  diagnostics.dispose()
  resolve({ ok: true, value: {} })
  await new Promise((finish) => setImmediate(finish))
  assert.deepEqual(batches.map((batch) => batch.records.length), [64, 6])
  assert.equal(batches[0].records[0].fields.callId, 'call')
  assert.doesNotMatch(JSON.stringify(batches), /秘密/u)
})

test('非 Stage0 不安装文件日志和性能监视器', () => {
  const previous = process.env.CODINGNS4DSH_PROFILE_NAME
  process.env.CODINGNS4DSH_PROFILE_NAME = 'isolated-test'
  try { assert.equal(installVoiceDiagnostics(() => true), undefined); traceVoice('host.test') }
  finally { if (previous === undefined) delete process.env.CODINGNS4DSH_PROFILE_NAME; else process.env.CODINGNS4DSH_PROFILE_NAME = previous }
})

test('Stage0 的浏览器 RPC 与 Python 分阶段指标通过同一链路真实落盘', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-integration-'))
  const keys = ['CODINGNS4DSH_PROFILE_NAME', 'CODINGNS4DSH_STAGE0_REPO_ROOT', 'CODINGNS4DSH_STAGE0_LAUNCHER', 'CODINGNS4DSH_VOICE_DIAGNOSTICS']
  const previous = keys.map((key) => process.env[key])
  process.env.CODINGNS4DSH_PROFILE_NAME = 'stage0'; process.env.CODINGNS4DSH_STAGE0_REPO_ROOT = directory
  process.env.CODINGNS4DSH_STAGE0_LAUNCHER = 'isolated-test'; delete process.env.CODINGNS4DSH_VOICE_DIAGNOSTICS
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc } as CodingNsHostServices)
  const worker = new MossTtsWorker({ python: process.env.CODINGNS4DSH_TTS_PYTHON || 'python3', script: fileURLToPath(new URL('./fixtures/moss-worker.py', import.meta.url)), modelDirectory: 'fixture', timeoutMs: 2000 })
  t.after(async () => {
    await worker.dispose(); await registry.reconcile([])
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    await rm(directory, { recursive: true, force: true })
  })
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc'])
  const handler = createCodingNsRpcHandler(rpc)
  const result = await handler('assistant/voice/diagnostics', { ownerId: 'page', records: [{ timestamp: Date.now(), event: 'client.tts.chunk', fields: { diagnosticId: 'integrated', audioMs: 80, ownerId: 'forged-owner', text: '秘密' } }] }, new AbortController().signal)
  assert.equal(result.ok, true)
  await worker.request('synthesize', { text: '不保存的文本', diagnosticId: 'integrated' }, () => {})
  await registry.reconcile([])
  const files = await readdir(join(directory, 'data/logs'))
  const content = await readFile(join(directory, 'data/logs', files[0]!), 'utf8')
  assert.match(content, /host.moss.phase/u); assert.match(content, /client.tts.chunk/u)
  assert.match(content, /prefill/u); assert.match(content, /integrated/u)
  assert.doesNotMatch(content, /秘密|禁止写入日志|不保存的文本|forged-owner/u)
})

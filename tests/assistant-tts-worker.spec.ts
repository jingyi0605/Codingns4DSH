import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MossTtsWorker } from '../src/host/features/moss-tts-worker.js'

// 与实际初始化的覆盖项一致；Windows 常见解释器入口没有 python3 别名。
const options = { python: process.env.CODINGNS4DSH_TTS_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3'),
  script: fileURLToPath(new URL('./fixtures/moss-worker.py', import.meta.url)), modelDirectory: 'fixture', idleMs: 50, timeoutMs: 2000 }

test('工作进程复用、传递所选音色、流式 PCM，空闲后释放', async (t) => {
  const worker = new MossTtsWorker(options); t.after(() => worker.dispose())
  const first = await worker.request('probe', {})
  const chunks: Uint8Array[] = []
  const next = await worker.request('synthesize', { voice: 'Lingyu', text: '你好' }, (chunk) => chunks.push(chunk.bytes))
  assert.equal(next.pid, first.pid); assert.equal(next.voice, 'Lingyu')
  assert.deepEqual([...chunks[0]!], [0, 0, 255, 127])
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.throws(() => process.kill(Number(first.pid), 0), /ESRCH/u)
})

test('启动失败和请求失败可诊断，失败请求后仍可继续推理', async (t) => {
  const broken = new MossTtsWorker({ ...options, modelDirectory: 'fail-start' }); t.after(() => broken.dispose())
  await assert.rejects(broken.request('probe', {}), /fixture startup failure/u)
  const worker = new MossTtsWorker(options); t.after(() => worker.dispose())
  await assert.rejects(worker.request('probe', { fail: true }), /fixture request failure/u)
  assert.ok((await worker.request('probe', {})).pid)
})

test('取消与超时真正终止工作进程；同时请求不会交叉响应', async (t) => {
  const worker = new MossTtsWorker(options); t.after(() => worker.dispose())
  const before = await worker.request('probe', {})
  const controller = new AbortController()
  const pending = worker.request('probe', { hang: true }, undefined, controller.signal)
  await assert.rejects(worker.request('probe', {}), /另一个请求/u)
  controller.abort()
  await assert.rejects(pending, /取消/u)
  assert.throws(() => process.kill(Number(before.pid), 0), /ESRCH/u)
  assert.notEqual((await worker.request('probe', {})).pid, before.pid)
  const timeout = new MossTtsWorker({ ...options, timeoutMs: 150 }); t.after(() => timeout.dispose())
  await assert.rejects(timeout.request('probe', { hang: true }), /超时/u)
})

test('ANSI 宿主环境中中文文本、路径和错误仍按 UTF-8 往返，释放完成后进程已退出', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-中文 空格-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const overrides = { PYTHONIOENCODING: 'cp1252', PYTHONUTF8: '0', PYTHONHOME: '/invalid-python-home', PYTHONPATH: '/invalid-python-path' }
  for (const [name, value] of Object.entries(overrides)) {
    const previous = process.env[name]; process.env[name] = value
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  }
  const worker = new MossTtsWorker({ ...options, modelDirectory: directory, idleMs: 2000 })
  t.after(() => worker.dispose())
  const text = '你好，Windows！😊'
  const codesPath = join(directory, '中文 编码.json')
  const result = await worker.request('encode', { text, codesPath })
  assert.equal(result.text, text); assert.equal(result.codesPath, codesPath)
  assert.equal(result.modelDirectory, directory)
  assert.match(String(result.stdinEncoding), /^utf-?8$/iu); assert.match(String(result.stdoutEncoding), /^utf-?8$/iu)
  assert.equal(result.pythonHome, null); assert.equal(result.pythonPath, null)
  assert.equal(await readFile(codesPath, 'utf8'), '中文参考编码')
  await assert.rejects(worker.request('probe', { fail: true }), /中文错误/u)
  await worker.dispose()
  assert.throws(() => process.kill(Number(result.pid), 0), /ESRCH/u)
  await assert.rejects(worker.request('probe', {}), /已经释放/u)
})

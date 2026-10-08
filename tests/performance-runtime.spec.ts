import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAsyncCommand, withCommandSignal } from '../data/build/dist/host/cli-adapters/process-utils.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { AssistantSourceCache } from '../data/build/dist/host/features/assistant-source-cache.js'
import { SherpaWorkerRuntime } from '../data/build/dist/host/features/sherpa-worker-runtime.js'
import { startSerialPolling } from '../data/build/dist/client/serial-polling.js'
import { callCodingNsRpcResult } from '../data/build/dist/client/rpc-call.js'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('真实异步短命令不阻塞心跳，并且超时会终止进程', async () => {
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 20)
  const result = await runAsyncCommand(spawnSync, process.execPath, ['-e', 'setTimeout(() => console.log("done"), 150)'])
  clearTimeout(timer)
  assert.equal(heartbeat, true)
  assert.equal(result.stdout.trim(), 'done')
  const expired = await runAsyncCommand(spawnSync, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 30 })
  assert.notEqual(expired.status, 0)
  assert.equal(expired.signal, 'SIGKILL')
})

test('停用探测取消运行与排队任务，释放的并发槽可以继续使用', async () => {
  const controller = new AbortController()
  const commands = withCommandSignal(controller.signal, () => Array.from({ length: 6 }, () =>
    runAsyncCommand(spawnSync, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])))
  const settled = Promise.allSettled(commands)
  await delay(30)
  controller.abort()
  const results = await settled
  assert.equal(results.filter((result) => result.status === 'rejected').length, 4, '排队任务不应启动子进程')
  assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.error?.name === 'AbortError').length, 2)
  assert.equal((await runAsyncCommand(spawnSync, process.execPath, ['-e', 'console.log("available")'])).stdout.trim(), 'available')
})

test('已绑定会话零历史读取，未知旧会话只检查一次，相同更新不落盘', async () => {
  let scans = 0, writes = 0
  const store = new CodingNsCliSessionStore({ persistence: { async write() { writes++ } } })
  store.upsert('bound', { adapterId: 'codex', title: '会话' })
  await store.flush()
  const bound = { id: 'bound', snapshotEvents() { scans++; throw new Error('不应读取历史') } }
  const native = { id: 'native', snapshotEvents() { scans++; return [] } }
  for (let index = 0; index < 50; index++) {
    store.migrateLegacySessions([bound, native]); store.adapterBindings()
    store.upsert('bound', { adapterId: 'codex', title: '会话' })
  }
  await store.flush()
  assert.equal(scans, 1)
  assert.equal(writes, 1)
})

test('保存进行期间只保留一个最新快照，flush 等待最后一次绑定', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const writes: unknown[][] = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(records) {
    writes.push([...records]); if (writes.length === 1) await blocked
    store.sync(records)
  } } })
  store.upsert('s', { adapterId: 'codex' })
  await delay(0)
  for (let index = 0; index < 50; index++) store.upsert('s', { providerSessionId: `thread-${index}` })
  release(); await store.flush()
  assert.equal(writes.length, 2)
  assert.equal((writes[1]?.[0] as { providerSessionId: string }).providerSessionId, 'thread-49')
})

test('标题按版本复用，并发元数据请求合并', async () => {
  const cache = new AssistantSourceCache()
  let reads = 0
  const read = async () => { reads++; await delay(10); return '标题' }
  assert.deepEqual(await Promise.all([cache.title('s', 'v1', true, read), cache.title('s', 'v1', true, read)]), ['标题', '标题'])
  await cache.title('s', 'v1', true, read); assert.equal(reads, 1)
  await cache.title('s', 'v2', true, read); assert.equal(reads, 2)
  cache.invalidateTitle('s'); await cache.title('s', 'v2', true, read); assert.equal(reads, 3)
  await Promise.all([cache.share('list', read), cache.share('list', read)])
  assert.equal(reads, 4)
})

test('慢轮询合并手动刷新，销毁后不再调度', async () => {
  let calls = 0, concurrent = 0, maximum = 0
  const poll = startSerialPolling(async () => { calls++; concurrent++; maximum = Math.max(maximum, concurrent); await delay(30); concurrent-- }, 5)
  await Promise.all([poll.refresh(), poll.refresh(), poll.refresh()])
  assert.equal(calls, 1)
  assert.equal(maximum, 1)
  poll.dispose(); await delay(30); assert.equal(calls, 1)
})

test('隐藏页面暂停轮询，可见时恢复，销毁取消在途请求', async () => {
  const dom = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  let calls = 0, signal: AbortSignal | undefined
  const poll = startSerialPolling(async (nextSignal) => { calls++; signal = nextSignal }, 10, { document: dom as unknown as Document })
  await delay(20); assert.equal(calls, 0)
  dom.visibilityState = 'visible'; dom.dispatchEvent(new Event('visibilitychange'))
  await delay(0); assert.equal(calls, 1)
  dom.visibilityState = 'hidden'; dom.dispatchEvent(new Event('visibilitychange'))
  await delay(30); assert.equal(calls, 1)
  poll.dispose(); assert.equal(signal?.aborted, true)
})

test('语音 405 回退后记住正确路由，不因普通错误重复提交', async () => {
  const calls: string[] = []
  const rpc = { async call(channel: string) {
    calls.push(channel)
    if (channel !== '/api') throw new Error('HTTP 405')
    return { ok: true as const, value: {} }
  } }
  await callCodingNsRpcResult(rpc, 'assistant/voice/unregister-client', {})
  await callCodingNsRpcResult(rpc, 'assistant/voice/unregister-client', {})
  assert.deepEqual(calls, ['/codingns', '/api', '/api'])
  let attempts = 0
  await assert.rejects(callCodingNsRpcResult({ async call() { attempts++; throw new Error('timeout') } }, 'write', {}), /timeout/u)
  assert.equal(attempts, 1)
})

test('工作线程推理保持 Host 心跳、限制积压并闲置释放模型', async (t) => {
  const runtime = new SherpaWorkerRuntime({ packageName: new URL('./fixtures/sherpa-blocking.mjs', import.meta.url).href, env: {
    CODINGNS4DSH_VOICE_ASR_ENCODER: 'encoder', CODINGNS4DSH_VOICE_ASR_DECODER: 'decoder',
    CODINGNS4DSH_VOICE_ASR_JOINER: 'joiner', CODINGNS4DSH_VOICE_ASR_TOKENS: fileURLToPath(new URL('./fixtures/sherpa-tokens.txt', import.meta.url)),
  } }, 30)
  t.after(() => runtime.dispose())
  const events: string[] = []
  runtime.subscribe((event) => { if (event.type === 'partial') events.push(event.text) })
  await runtime.start()
  assert.equal(runtime.capabilities.realtime, true)
  const frame = { sequence: 1, bytes: new Uint8Array(32_000), channels: 1 as const, sampleRate: 16_000 }
  const started = performance.now()
  const decode = runtime.sendPcm(frame, 0)
  await delay(30)
  assert.ok(performance.now() - started < 200, '250 ms 原生推理不能阻塞 Host 定时器')
  await assert.rejects(runtime.sendPcm({ ...frame, bytes: new Uint8Array(64_000) }, 0), /积压/u)
  await decode
  assert.deepEqual(events, ['工作线程识别结果'])
  await runtime.stop()
  assert.equal(runtime.running, false)
  await delay(100)
  assert.equal(runtime.capabilities.realtime, false)
})

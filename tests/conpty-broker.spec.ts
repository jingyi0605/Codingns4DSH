import assert from 'node:assert/strict'
import test from 'node:test'
import { ConptyTerminalBackend, conptyPipeName } from '../data/build/dist/host/terminal/backends/conpty-backend.js'
import {
  BoundedTerminalBuffer,
  ExclusiveAttachmentLease,
  createJsonLineParser,
  parseBrokerRequest,
  writeBrokerMessage,
} from '../data/build/dist/host/terminal/broker/conpty-broker-protocol.js'

const session = {
  runtimeSessionKey: 'secret-runtime-session-key',
  runtimeType: 'conpty-powershell',
  shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  shellArgs: ['-NoLogo'],
  cwd: 'C:\\project',
}

test('broker JSON 行协议可处理拆包并拒绝未知操作', () => {
  const values = []
  const parser = createJsonLineParser((value) => values.push(value))
  const target = { value: '', write(chunk) { this.value += chunk } }
  writeBrokerMessage(target, { version: 1, auth: 'secret', type: 'inspect' })
  parser.push(target.value.slice(0, 8))
  parser.push(target.value.slice(8))
  assert.deepEqual(parseBrokerRequest(values[0]), { version: 1, auth: 'secret', type: 'inspect' })
  assert.equal(parseBrokerRequest({ version: 1, auth: 'secret', type: 'take-over' }), null)
})

test('broker 离线输出缓冲严格限制字节数并保留最新输出', () => {
  const buffer = new BoundedTerminalBuffer(12)
  buffer.push('旧输出-')
  buffer.push('new-output')
  assert.ok(buffer.byteLength <= 12)
  assert.match(buffer.drain(), /output$/)
  assert.equal(buffer.byteLength, 0)
})

test('broker 支持新 attach 接管输入且旧 attach 保持只读', () => {
  const lease = new ExclusiveAttachmentLease()
  const first = {}
  const second = {}
  assert.equal(lease.acquire(first), true)
  assert.equal(lease.takeover(second), first)
  assert.equal(lease.current, second)
  lease.release(second)
  assert.equal(lease.current, null)
  assert.equal(lease.acquire(second), true)
})

test('broker 回放缓冲不会因一次 attach 被清空', () => {
  const buffer = new BoundedTerminalBuffer(64)
  buffer.push('prompt> pwd\r\n/project')
  assert.equal(buffer.snapshot(), 'prompt> pwd\r\n/project')
  assert.equal(buffer.snapshot(), 'prompt> pwd\r\n/project')
})

test('ConPTY backend 启动独立 broker 后检查同一进程身份', async () => {
  let launched = false
  let inspectCount = 0
  const launches = []
  const client = {
    async inspect(_pipeName, _auth, runtimeSessionKey) {
      inspectCount += 1
      if (!launched) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { alive: true, runtimeSessionKey, runtimePid: 88, shellPid: 99 }
    },
    async attach() { throw new Error('本测试不 attach') },
    async terminate() {},
  }
  const backend = new ConptyTerminalBackend({
    platform: 'win32',
    brokerClient: client,
    launchBroker(input) { launches.push(input); launched = true },
    startupAttempts: 2,
    startupDelayMs: 0,
  })
  const created = await backend.create({ session })
  assert.deepEqual(created, { alive: true, runtimeSessionKey: session.runtimeSessionKey, runtimePid: 88, shellPid: 99 })
  assert.equal(inspectCount, 2)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].pipeName, conptyPipeName(session.runtimeSessionKey))
  assert.equal(launches[0].auth, session.runtimeSessionKey)
})

test('ConPTY detach 不终止 broker，显式 terminate 才结束运行时', async () => {
  const calls = []
  const attachment = {
    attachmentId: 'attach-win',
    identity: { alive: true, runtimeSessionKey: session.runtimeSessionKey, runtimePid: 88, shellPid: 99 },
    write(data) { calls.push(`write:${data}`) },
    resize(cols, rows) { calls.push(`resize:${cols}x${rows}`) },
    async detach() { calls.push('detach') },
  }
  const client = {
    async inspect(_pipe, _auth, runtimeSessionKey) {
      return { alive: true, runtimeSessionKey, runtimePid: 88, shellPid: 99 }
    },
    async attach() { calls.push('attach'); return attachment },
    async terminate() { calls.push('terminate') },
  }
  const backend = new ConptyTerminalBackend({ platform: 'win32', brokerClient: client })
  const result = await backend.attach({ session, cols: 120, rows: 30, onData() {} })
  await backend.write({ attachmentId: result.attachmentId, data: 'dir\r' })
  await backend.resize({ attachmentId: result.attachmentId, cols: 160, rows: 50 })
  await backend.detach(result.attachmentId)
  assert.deepEqual(calls, ['attach', 'write:dir\r', 'resize:160x50', 'detach'])
  await backend.terminate(session)
  assert.deepEqual(calls, ['attach', 'write:dir\r', 'resize:160x50', 'detach', 'terminate'])
})

test('ConPTY backend 在非 Windows 平台明确拒绝运行', async () => {
  const backend = new ConptyTerminalBackend({ platform: 'darwin' })
  await assert.rejects(() => backend.inspect(session), { code: 'TERMINAL_PLATFORM_UNSUPPORTED' })
})

test('Named Pipe 名称不泄露 runtimeSessionKey 且对同一 key 稳定', () => {
  const first = conptyPipeName(session.runtimeSessionKey)
  assert.equal(first, conptyPipeName(session.runtimeSessionKey))
  assert.equal(first.includes(session.runtimeSessionKey), false)
  assert.match(first, /^\\\\\.\\pipe\\dsh-codingns-[a-f0-9]{40}$/)
})

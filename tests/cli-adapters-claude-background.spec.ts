import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../src/host/cli-adapters/claude-driver.js'
import { applyClaudeTaskEvent } from '../src/host/cli-adapters/claude-background.js'
import { externalTurnMessage, readExternalTurn, supportsBackgroundTurns } from '../src/host/cli-adapters/background-turn.js'
import type { CodingNsAgentEvent, CodingNsCliTurnInput } from '../src/shared/contracts/cli-adapter.js'
import type { CodingNsBackgroundTurn } from '../src/host/cli-adapters/background-turn.js'

const providerSessionId = 'claude-background-conversation'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface FakeChild {
  readonly send: (value: object) => void
  /** 模拟进程退出：关闭 stdout，不再有任何输出。 */
  readonly exit: () => void
  readonly input: Record<string, unknown>[]
  killed: boolean
}

/** 每次 spawn 得到一个独立的假 Claude 进程，stdin 写入会被记录并可触发回复。 */
function fakeClaude(onUserMessage?: (child: FakeChild, count: number) => void) {
  const children: FakeChild[] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude.exe'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.330', stderr: '' })) as never,
    spawn: ((_command: string, args: readonly string[]) => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
      const child: FakeChild = {
        input: [], killed: false,
        send: (value) => { stdout.write(`${JSON.stringify(value)}\n`) },
        exit: () => { stdout.end(); stderr.end() },
      }
      children.push(child)
      launchArgs.push(args)
      let users = 0
      stdin.on('data', (data) => {
        for (const line of String(data).split('\n').filter(Boolean)) {
          const parsed = JSON.parse(line) as Record<string, unknown>
          child.input.push(parsed)
          if (parsed.type === 'user') onUserMessage?.(child, ++users)
        }
      })
      return Object.assign(new EventEmitter(), {
        stdin, stdout, stderr,
        kill() { child.killed = true; stdout.end(); stderr.end(); return true },
      })
    }) as never,
  })
  const launchArgs: (readonly string[])[] = []
  return { driver, children, launchArgs }
}

const baseInput: Partial<CodingNsCliTurnInput> = {
  sessionId: 'claude-bg', messages: [], prompt: 'run the tests in the background', modelId: 'sonnet',
  permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
}

async function collect(driver: ClaudeCodeDriver, input: Partial<CodingNsCliTurnInput> = {}): Promise<CodingNsAgentEvent[]> {
  const events: CodingNsAgentEvent[] = []
  for await (const event of driver.executeTurn({ ...baseInput, ...input } as CodingNsCliTurnInput)) events.push(event)
  return events
}

const text = (events: readonly CodingNsAgentEvent[]) => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')
const textDelta = (value: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } })
const result = (value: string, extra: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: value, session_id: providerSessionId, ...extra })
const tasksChanged = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash' })) })

/** 第一轮：启动一个后台任务后正常结束，进程应该被保留。 */
function startBackgroundTask(child: FakeChild): void {
  child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
  child.send({ type: 'system', subtype: 'task_started', task_id: 't1', is_backgrounded: true })
  child.send(tasksChanged('t1'))
  child.send(textDelta('waiting'))
  child.send(result('waiting'))
}

/** 任务结束后 Claude 自己开的一轮，对应抓包里 task_updated → task_notification → init → result。 */
function notifyTaskDone(child: FakeChild, reply: string): void {
  child.send({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } })
  child.send({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'Background command "sleep" completed (exit code 0)' })
  child.send(tasksChanged())
  child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
  child.send(textDelta(reply))
  child.send(result(reply, { origin: { kind: 'task-notification', producer: 'session-task' } }))
}

test('任务记账事件按 background_tasks_changed、task_updated、task_notification 维护集合', () => {
  const tasks = new Set<string>()
  applyClaudeTaskEvent(tasks, { type: 'system', subtype: 'task_started', task_id: 'a', is_backgrounded: true })
  applyClaudeTaskEvent(tasks, { type: 'system', subtype: 'task_started', task_id: 'b', is_backgrounded: false })
  assert.deepEqual([...tasks], ['a'])
  applyClaudeTaskEvent(tasks, tasksChanged('a', 'c'))
  assert.deepEqual([...tasks].sort(), ['a', 'c'])
  applyClaudeTaskEvent(tasks, { type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'running' } })
  assert.equal(tasks.has('a'), true)
  applyClaudeTaskEvent(tasks, { type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'completed' } })
  assert.equal(tasks.has('a'), false)
  assert.equal(applyClaudeTaskEvent(tasks, { type: 'system', subtype: 'task_notification', task_id: 'c', summary: ' done ' }), 'done')
  assert.equal(tasks.size, 0)
  assert.equal(applyClaudeTaskEvent(tasks, { type: 'assistant' }), undefined)
})

test('收件箱通知带摘要，并只对支持后台回合的适配器生效', () => {
  const message = externalTurnMessage({ sessionId: 's', providerSessionId: 'p', turnId: 't', summary: '后台任务通知：done' })
  assert.equal(message.source.summary, '后台任务通知：done')
  assert.deepEqual(readExternalTurn([message as never]), { turnId: 't', providerSessionId: 'p' })
  assert.equal(externalTurnMessage({ sessionId: 's', providerSessionId: 'p', turnId: 't' }).source.summary, '工作流执行结果')
  assert.equal(supportsBackgroundTurns('claude-code'), true)
  assert.equal(supportsBackgroundTurns('zcode'), true)
  assert.equal(supportsBackgroundTurns('codex'), false)
})

test('没有后台任务时回合结束仍然终止进程', async () => {
  const f = fakeClaude((child) => {
    child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
    child.send(textDelta('hello'))
    child.send(result('hello'))
  })
  const events = await collect(f.driver)
  assert.equal(text(events), 'hello')
  assert.equal(f.children[0]!.killed, true)
  f.driver.dispose()
})

test('后台任务结束后唤醒：同一进程的新一轮被缓存并由 externalTurnId 领取', async (t) => {
  const f = fakeClaude((child) => startBackgroundTask(child))
  t.after(() => f.driver.dispose())
  const woken: CodingNsBackgroundTurn[] = []
  f.driver.subscribeBackgroundTurns((turn) => { woken.push(turn) })

  const first = await collect(f.driver)
  assert.equal(text(first), 'waiting')
  assert.equal(first.at(-1)?.type, 'finish')
  assert.equal(f.children[0]!.killed, false, '仍有后台任务时不能终止进程')
  assert.equal(woken.length, 0)

  notifyTaskDone(f.children[0]!, 'BG_DONE')
  await sleep(50)
  assert.equal(woken.length, 1)
  assert.equal(woken[0]!.providerSessionId, providerSessionId)
  assert.match(woken[0]!.summary ?? '', /后台任务通知：Background command "sleep" completed/)

  const events = await collect(f.driver, { providerSessionId, prompt: '', externalTurnId: woken[0]!.turnId })
  assert.equal(text(events), 'BG_DONE')
  assert.equal(events.at(-1)?.type, 'finish')
  assert.equal((events.at(-1) as { reason: string }).reason, 'stop')
  assert.equal(f.launchArgs.length, 1, '唤醒不能再启动新的 Claude 进程')

  // 同一轮被再次领取（收件箱重放）时只返回空结束，不重复输出。
  const replay = await collect(f.driver, { providerSessionId, prompt: '', externalTurnId: woken[0]!.turnId })
  assert.equal(text(replay), '')
  assert.equal((replay.at(-1) as { reason: string }).reason, 'stop')

  // 任务都结束且没有新的通知后，进程会被回收。
  await sleep(3_600)
  assert.equal(f.children[0]!.killed, true)
})

test('进程保留期间用户再发消息：复用同一进程，不重复握手，并先消费未领取的后台回合', async (t) => {
  let replies = 0
  const f = fakeClaude((child, count) => {
    if (count === 1) startBackgroundTask(child)
    else {
      replies++
      child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
      child.send(textDelta('USER_REPLY'))
      child.send(result('USER_REPLY'))
    }
  })
  t.after(() => f.driver.dispose())
  f.driver.subscribeBackgroundTurns(() => undefined)

  await collect(f.driver)
  notifyTaskDone(f.children[0]!, 'BG_DONE')
  await sleep(50)

  const events = await collect(f.driver, { providerSessionId, prompt: 'how is it going' })
  assert.equal(replies, 1)
  assert.equal(f.launchArgs.length, 1, '复用上一轮保留的进程')
  assert.equal(text(events), 'BG_DONEUSER_REPLY')
  assert.equal(events.some((e) => e.type === 'message-boundary'), true, '后台输出和用户回复之间要有消息边界')
  const handshakes = f.children[0]!.input.filter((m) => m.type === 'control_request')
  assert.equal(handshakes.length, 1, 'initialize 只发一次')
  assert.equal(f.children[0]!.input.filter((m) => m.type === 'user').length, 2)
  assert.equal(f.children[0]!.killed, true, '没有后台任务后随用户回合一起回收')
})

test('模型等启动参数变化后不复用旧进程', async (t) => {
  const f = fakeClaude((child, count) => {
    if (child === f.children[0] && count === 1) startBackgroundTask(child)
    else {
      child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
      child.send(textDelta('FRESH'))
      child.send(result('FRESH'))
    }
  })
  t.after(() => f.driver.dispose())
  await collect(f.driver)
  const events = await collect(f.driver, { providerSessionId, prompt: 'switch', modelId: 'opus' })
  assert.equal(text(events), 'FRESH')
  assert.equal(f.launchArgs.length, 2)
  assert.equal(f.children[0]!.killed, true)
  assert.ok(f.launchArgs[1]!.includes('--resume'))
})

test('后台回合进行中进程退出：领取方得到失败结束而不是一直挂起', async (t) => {
  const f = fakeClaude((child) => startBackgroundTask(child))
  t.after(() => f.driver.dispose())
  const woken: CodingNsBackgroundTurn[] = []
  f.driver.subscribeBackgroundTurns((turn) => { woken.push(turn) })
  await collect(f.driver)
  const child = f.children[0]!
  child.send({ type: 'system', subtype: 'init', session_id: providerSessionId })
  child.send(textDelta('partial'))
  await sleep(30)
  assert.equal(woken.length, 1)
  // 这一轮还没出 result，进程就消失了。
  child.exit()
  await sleep(30)
  const events = await collect(f.driver, { providerSessionId, prompt: '', externalTurnId: woken[0]!.turnId })
  const finish = events.at(-1) as { type: string; reason: string; failure?: { message: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason, 'error')
  assert.match(finish.failure?.message ?? '', /进程已退出/)
})

test('任务结束但没有新一轮时，进程在宽限期后被回收', async (t) => {
  const f = fakeClaude((child) => startBackgroundTask(child))
  t.after(() => f.driver.dispose())
  await collect(f.driver)
  const child = f.children[0]!
  // 任务被直接终止：只有任务列表清空，没有 task_notification，也没有新的一轮。
  child.send({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } })
  child.send(tasksChanged())
  await sleep(100)
  assert.equal(child.killed, false)
  await sleep(3_400)
  assert.equal(child.killed, true)
})

/** 最小的 Registry / 原生会话替身，只覆盖投递链路用到的方法。 */
function deliveryHarness(adapterId: string, boundProviderSessionId = providerSessionId) {
  let listener: ((turn: CodingNsBackgroundTurn) => void) | undefined
  const enqueued: { turn: CodingNsBackgroundTurn }[] = []
  const registry = {
    getSession: () => ({ adapterId, providerSessionId: boundProviderSessionId }),
    subscribeBackgroundTurns: (next: (turn: CodingNsBackgroundTurn) => void) => { listener = next; return () => { listener = undefined } },
    recoverBackgroundTurns: async () => [],
    stageRecoveredBackgroundTurn: () => undefined,
  }
  const native = {
    available: true,
    ensure: async (sessionId: string) => sessionId,
    enqueueExternalTurn: (turn: CodingNsBackgroundTurn) => { enqueued.push({ turn }); return true },
    list: () => [],
    subscribe: () => () => undefined,
  }
  return { registry, native, enqueued, emit: (turn: CodingNsBackgroundTurn) => listener?.(turn) }
}

test('投递链路：claude-code 会话的后台回合会写进 DSH 收件箱唤醒会话', async () => {
  const { installBackgroundTurnDelivery } = await import('../src/host/cli-adapters/background-turn-delivery.js')
  const h = deliveryHarness('claude-code')
  const stop = installBackgroundTurnDelivery(h.registry as never, h.native as never)
  try {
    const turn = { sessionId: 'claude-bg', providerSessionId, turnId: 'claude-bg-1', summary: '后台任务通知：done' }
    h.emit(turn)
    await sleep(30)
    assert.equal(h.enqueued.length, 1)
    assert.deepEqual(h.enqueued[0]!.turn, turn)
    // 同一轮不会重复入队。
    h.emit(turn)
    await sleep(30)
    assert.equal(h.enqueued.length, 1)
  } finally { stop() }
})

test('投递链路：绑定的 Provider 会话不一致，或不是支持后台回合的适配器时丢弃', async () => {
  const { installBackgroundTurnDelivery } = await import('../src/host/cli-adapters/background-turn-delivery.js')
  for (const h of [deliveryHarness('claude-code', 'another-provider-session'), deliveryHarness('codex')]) {
    const stop = installBackgroundTurnDelivery(h.registry as never, h.native as never)
    try {
      h.emit({ sessionId: 'claude-bg', providerSessionId, turnId: 'claude-bg-2' })
      await sleep(30)
      assert.equal(h.enqueued.length, 0)
    } finally { stop() }
  }
})

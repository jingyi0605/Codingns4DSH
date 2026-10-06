import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceAgentService } from '../data/build/dist/host/features/voice-agent-service.js'

test('能力报告只声明实际支持的能力', () => {
  const service = new VoiceAgentService({ realtime: true, audioInput: true, streamingAudio: true })
  assert.equal(service.capabilities().realtime, true)
  assert.equal(service.capabilities().wakeWord, false)
})

test('owner 前缀 startsWith 且后注册者优先，假值静默不匹配', () => {
  const service = new VoiceAgentService()
  const first = service.registerActions('owner:', { run: { execute: () => 'first' } })
  service.registerActions('owner:', { run: { execute: () => 'second' } })
  assert.equal(service.lookupActions('owner:session')?.run.execute(null, { resolve: () => true }), 'second')
  assert.equal(service.lookupActions(null), null)
  first.dispose()
  assert.equal(service.lookupActions('owner:session')?.run.execute(null, { resolve: () => true }), 'second')
})

test('动作事件自动执行并发出 action-result，未知动作返回契约文案', async () => {
  const service = new VoiceAgentService()
  service.registerActions('owner:', {
    echo: { execute: (args) => ({ value: args }) },
  })
  const conversation = await service.startConversation({ ownerId: 'owner:session' })
  const events: unknown[] = []
  conversation.subscribe((event) => events.push(event))
  conversation.handleEvent({ type: 'action', callId: '1', name: 'echo', arguments: '{"x":1}' })
  conversation.handleEvent({ type: 'action', callId: '2', name: 'missing', arguments: '{}' })
  const results = events.filter((event) => (event as { type?: string }).type === 'action-result') as Array<{ callId: string; ok: boolean; output?: unknown; error?: string }>
  assert.deepEqual(results[0], { type: 'action-result', callId: '1', name: 'echo', ok: true, output: { value: { x: 1 } } })
  assert.deepEqual(results[1], { type: 'action-result', callId: '2', name: 'missing', ok: true, output: { ok: false, error: 'Unknown action: missing' } })
  await conversation.end()
})

test('control.resolve 幂等并返回 boolean，输出递归截断', async () => {
  const service = new VoiceAgentService()
  let resolveAgain: ((value: unknown) => boolean) | undefined
  service.registerActions('owner:', {
    long: {
      execute: (_args, control) => {
        resolveAgain = control.resolve
        assert.equal(control.resolve({ nested: 'x'.repeat(5000), list: ['y'.repeat(5000)] }), true)
        assert.equal(control.resolve('late'), false)
      },
    },
  })
  const conversation = await service.startConversation({ ownerId: 'owner:session' })
  const events: any[] = []
  conversation.subscribe((event) => events.push(event))
  conversation.handleEvent({ type: 'action', callId: 'long', name: 'long', arguments: '{}' })
  assert.equal(resolveAgain?.('later'), false)
  const result = events.find((event) => event.type === 'action-result')
  assert.equal(result.output.nested.length, 4000)
  assert.equal(result.output.list[0].length, 4000)
})

test('参数错误和 dispose 幂等', async () => {
  const service = new VoiceAgentService()
  const registration = service.registerActions('owner:', { run: { execute: () => 'ok' } })
  const conversation = await service.startConversation({ ownerId: 'owner:session' })
  const events: any[] = []
  conversation.subscribe((event) => events.push(event))
  conversation.handleEvent({ type: 'action', callId: 'bad', name: 'run', arguments: '{' })
  const invalid = events.find((event) => event.type === 'action-result')
  assert.deepEqual(invalid.output, { ok: false, error: 'Invalid action arguments.' })
  registration.dispose()
  registration.dispose()
  conversation.handleEvent({ type: 'action', callId: 'missing', name: 'run', arguments: '{}' })
  assert.equal(events.filter((event) => event.type === 'action-result').length, 1)
})

test('异步动作超时前置武装且使用契约文案', async () => {
  const service = new VoiceAgentService()
  service.registerActions('owner:', { hang: { timeoutMs: 10, execute: () => new Promise(() => undefined) } })
  const conversation = await service.startConversation({ ownerId: 'owner:session' })
  const events: any[] = []
  conversation.subscribe((event) => { if (event.type === 'action-result') events.push(event) })
  conversation.handleEvent({ type: 'action', callId: 'timeout', name: 'hang', arguments: '{}' })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(events[0].output, { ok: false, error: 'Action execution timed out.' })
  await conversation.end()
})

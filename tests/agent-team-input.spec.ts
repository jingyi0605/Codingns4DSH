import assert from 'node:assert/strict'
import test from 'node:test'
import { TeamInputTracker, pendingPeerInput } from '../data/build/dist/host/cli-adapters/team-input.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import type { CodingNsAgentEvent, CodingNsCliMessage, CodingNsCliTurnInput } from '../data/build/dist/shared/contracts/cli-adapter.js'

const human: CodingNsCliMessage = { id: 'human', role: 'user', source: { kind: 'user' }, content: 'Original task' }
const peer = (id: string, text: string): CodingNsCliMessage => ({ id, role: 'user', source: { kind: 'agent-message', form: 'relay' }, content: `Team message from reviewer: ${text}` })
const settled = (id: string, text: string): CodingNsCliMessage => ({ id, role: 'user',
  source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'teammate' }, content: text })

test('new peer input is selected in order without replaying the old human task', () => {
  const first = peer('one', 'Fix the race')
  const second = peer('two', 'Also add cancellation')
  const history = [human, { role: 'assistant', content: 'Previous result' } as const, first, second]
  assert.deepEqual(pendingPeerInput(history), [first, second])
  const tracker = new TeamInputTracker()
  tracker.accept('session', [first])
  tracker.accept('session', [first, second])
  assert.deepEqual(tracker.take('session', history), [first, second])
  tracker.accept('session', [{ id: 'notice', role: 'user', source: { kind: 'model-selection', form: 'notice' }, content: 'Continue' }])
  assert.deepEqual(tracker.take('session', history), [])
  tracker.accept('other', [second])
  assert.deepEqual(tracker.take('session', history), [])
  assert.deepEqual(tracker.take('other', history), [second])
})

test('native pre-step observation prevents cold history from automatically replaying uncertain peer work', () => {
  const tracker = new TeamInputTracker()
  tracker.accept('resumed', [])
  assert.throws(() => tracker.take('resumed', [human, peer('old', 'May already be processed')]), { code: 'TEAM_DELIVERY_UNCERTAIN' })
  const historical: CodingNsCliMessage = { id: 'legacy', role: 'user', source: { kind: 'team-message' }, content: 'Historical sender-framed input' }
  tracker.accept('resumed', [historical, human])
  assert.deepEqual(tracker.take('resumed', []), [historical, human])
  assert.equal(historical.source?.kind, 'team-message')
})

test('teammate settlement notices follow peer input ordering and delivery tracking', () => {
  const report = peer('report', 'Calculated 55')
  const completion = settled('completion', 'Background teammate finished. Its closing message: 55.')
  const history = [human, { role: 'assistant', content: 'Waiting for teammate' } as const, report, completion]
  const tracker = new TeamInputTracker()
  tracker.accept('lead', [report])
  tracker.accept('lead', [completion])
  assert.deepEqual(pendingPeerInput(history), [report, completion])
  assert.deepEqual(tracker.take('lead', history), [report, completion])
  assert.deepEqual(tracker.take('lead', history), [])
  tracker.accept('cold', [])
  assert.throws(() => tracker.take('cold', [human, completion]), { code: 'TEAM_DELIVERY_UNCERTAIN' })
})

for (const adapterId of ['codex', 'opencode']) {
  test(`${adapterId} Lead continues after prompt refresh and receives the teammate closing notice`, async () => {
    const hooks = new Map<string, any>(); const inputs: CodingNsCliTurnInput[] = []
    let listener: any; let generation = 0
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: adapterId, name: adapterId },
      detect: async () => ({ installed: true, version: 'test', command: 'fake' }),
      executeTurn: async function* (input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
        inputs.push(input)
        yield { type: 'text-delta', text: inputs.length === 1 ? 'Waiting for teammate' : 'Teammate result received' }
        yield { type: 'finish', reason: 'stop' }
      },
    } as never])
    const services = { systemPrompt: { assemble() {} } }
    const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(), dshVersion: '0.2.1-alpha.3',
      dshContext: { get: (name: keyof typeof services) => services[name], on(name: string, callback: unknown) { hooks.set(name, callback); return () => {} } } as never,
      sessionTranslation: {
        enabled: true, inputEnabled: true, get cacheKey() { return String(generation) },
        async translateInputDetailed(_adapter: string, text: string) { generation++; return { translated: text } },
        shouldTranslate: () => false, async translateOutput() { return null },
      } as never,
      events: { on(name: string, callback: unknown) { if (name === 'llm/stream') listener = callback; return () => {} } },
    })
    features.register(createCliAdaptersFeature({ registry }) as never)
    try {
      await features.start('cliAdapters')
      registry.setSession('lead', { adapterId, translationEnabled: true })
      const agent = { id: 'lead' }
      const original: CodingNsCliMessage = { ...human, source: { ...human.source, codingnsTranslationInput: {
        original: 'Original task', translated: 'Translated task', targetLanguage: 'en',
      } } }
      const completion = settled('completion', 'Background teammate finished. Its closing message: task-1 completed at revision 3; result 55.')
      const history: CodingNsCliMessage[] = [original]
      for (const messages of [[original], [completion]]) {
        const assembly = { sections: [{ name: 'host', text: 'Host instructions' }], tools: [] }
        assert.equal(await hooks.get('system-prompt/assemble')(assembly, { agent }, async () => assembly), assembly)
        const decision = await hooks.get('agent/pre-step')({ agent, messages }, async () => ({ kind: 'enter', messages }))
        assert.equal(decision.kind, 'enter')
        if (messages[0] === completion) history.push({ role: 'assistant', content: 'Waiting for teammate' }, completion)
        for await (const _chunk of listener({ sessionId: 'lead', messages: history }, async function* () { throw new Error('Unexpected native execution') })) { /* consume */ }
      }
      assert.equal(inputs[0]?.prompt, 'Translated task')
      assert.equal(inputs[1]?.prompt, completion.content)
      assert.equal(inputs[1]?.peerInput, true)
      assert.equal(generation, 2, 'Internal completion notices never enter user-input translation')
    } finally { await features.disable('cliAdapters') }
  })
}

test('the actual external LLM boundary forwards peer messages instead of the original prompt', async () => {
  const inputs: any[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Fake Codex', capabilities: ['stream'] },
    detect: async () => ({ installed: true, version: 'test', command: '/fake/codex' }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* (input: unknown) { inputs.push(input); yield { type: 'text-delta', text: 'Read peer instructions' }; yield { type: 'finish', reason: 'stop' } },
  } as never])
  let listener: any
  const table = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc: table, events: { on(name: string, callback: unknown) { if (name === 'llm/stream') listener = callback; return () => {} } } })
  features.register(createCliAdaptersFeature({ registry }) as never)
  try {
    await features.start('cliAdapters')
    registry.setSession('session', { adapterId: 'codex' })
    const messages = [human, { role: 'assistant', content: 'Earlier result' }, peer('one', 'Fix the race'), peer('two', 'Add cancellation')]
    for await (const _chunk of listener({ sessionId: 'session', messages }, async function* () { throw new Error('Unexpected native execution') })) { /* consume */ }
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].prompt, 'Team message from reviewer: Fix the race\n\nTeam message from reviewer: Add cancellation')
    assert.equal(inputs[0].messages.at(-1).source.kind, 'agent-message')
  } finally { await features.disable('cliAdapters') }
})

for (const adapterId of ['codex', 'opencode']) {
  test(`${adapterId} translates the human part of a mixed human and Team input batch`, async () => {
    const hooks = new Map<string, any>(); const inputs: CodingNsCliTurnInput[] = []; const translated: string[] = []
    let listener: any
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: adapterId, name: adapterId },
      detect: async () => ({ installed: true, version: 'test', command: 'fake' }),
      executeTurn: async function* (input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
        inputs.push(input); yield { type: 'text-delta', text: 'Received' }; yield { type: 'finish', reason: 'stop' }
      },
    } as never])
    const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(),
      dshContext: { get: () => undefined, on(name: string, callback: unknown) { hooks.set(name, callback); return () => {} } } as never,
      sessionTranslation: { enabled: true, inputEnabled: true, cacheKey: 'stable',
        async translateInputDetailed(_adapter: string, text: string) { translated.push(text); return { translated: text === '请检查已有任务' ? 'Please check the existing task' : 'Do not edit files' } },
        shouldTranslate: () => false, async translateOutput() { return null },
      } as never,
      events: { on(name: string, callback: unknown) { if (name === 'llm/stream') listener = callback; return () => {} } },
    })
    features.register(createCliAdaptersFeature({ registry }) as never)
    try {
      await features.start('cliAdapters')
      registry.setSession('lead', { adapterId, translationEnabled: true })
      const fresh: CodingNsCliMessage = { id: 'fresh-human', role: 'user', source: { kind: 'user' }, content: '请检查已有任务' }
      const extra: CodingNsCliMessage = { id: 'extra-human', role: 'user', source: { kind: 'user' }, content: '不要修改文件' }
      const report = peer('report', 'task-1 completed at revision 3; result 55')
      const decision = await hooks.get('agent/pre-step')({ agent: { id: 'lead' }, messages: [fresh, report, extra] }, async () => ({ kind: 'enter', messages: [fresh, report, extra] }))
      assert.deepEqual(translated, ['请检查已有任务', '不要修改文件'], 'Translate only real human input, never the sender-framed Team message')
      assert.equal(decision.messages[1], report)
      const history = [human, { role: 'assistant', content: 'Old response' }, ...decision.messages]
      for await (const _chunk of listener({ sessionId: 'lead', messages: history }, async function* () { throw new Error('Unexpected native execution') })) { /* consume */ }
      assert.equal(inputs[0]?.prompt, `Please check the existing task\n\n${report.content}\n\nDo not edit files`)
      assert.equal(inputs[0]?.peerInput, true)
      assert.deepEqual(translated, ['请检查已有任务', '不要修改文件'], 'The external boundary must not translate the mixed batch again')
      assert.equal(fresh.content, '请检查已有任务', 'The original message remains auditable')
    } finally { await features.disable('cliAdapters') }
  })
}

for (const withPeer of [false, true]) {
  test(`cancelling translated human input ${withPeer ? 'preserves a co-batched Team message' : 'still rejects an ordinary submission'}`, async () => {
    const hooks = new Map<string, any>(); const table = new CodingNsRpcTable()
    const registry = new CodingNsCliAdapterRegistry([{ descriptor: { id: 'codex', name: 'Codex' } } as never])
    const features = new FeatureRegistry({ rpc: table,
      dshContext: { get: () => undefined, on(name: string, callback: unknown) { hooks.set(name, callback); return () => {} } } as never,
      sessionTranslation: { enabled: true, inputEnabled: true,
        async translateInputDetailed(_adapter: string, text: string) { return { translated: text, failed: true } },
      } as never,
    })
    features.register(createCliAdaptersFeature({ registry }) as never)
    try {
      await features.start('cliAdapters')
      registry.setSession('lead', { adapterId: 'codex', translationEnabled: true })
      const fresh: CodingNsCliMessage = { id: 'cancelled-human', role: 'user', source: { kind: 'user' }, content: '请处理新要求' }
      const report = peer('keep-report', 'Existing task completed')
      const messages = withPeer ? [fresh, report] : [fresh]
      const result = hooks.get('agent/pre-step')({ agent: { id: 'lead' }, messages }, async () => ({ kind: 'enter', messages }))
      const pending = () => table.resolve('cli/translation/pending')!.handler('translation/pending', { sessionId: 'lead' }) as any[]
      for (let index = 0; index < 30 && pending().length === 0; index++) await new Promise(resolve => setImmediate(resolve))
      assert.equal(pending().length, 1)
      await table.resolve('cli/translation/resolve')!.handler('translation/resolve', { sessionId: 'lead', id: pending()[0].id, choice: 'cancel' })
      const decision = await result
      assert.equal(decision.kind, withPeer ? 'enter' : 'reject')
      if (withPeer) assert.deepEqual(decision.messages, [report], 'A cancelled human submission must not discard accepted Team work')
      assert.equal(pending().length, 0)
    } finally { await features.disable('cliAdapters') }
  })
}

for (const driverOwned of [false, true]) {
  test(`peer input survives ${driverOwned ? 'driver-owned' : 'retained iterator'} step boundaries and starts once after the active turn`, async () => {
    const calls: CodingNsCliTurnInput[] = []
    let released = 0
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: 'test', name: 'Test' },
      supportsSegmentedTurns: driverOwned,
      detect: async () => ({ installed: true, version: 'test', command: 'fake' }),
      listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
      executeTurn: async function* (input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
        calls.push(input)
        try {
          if (calls.length === 1) {
            yield { type: 'session-binding', providerSessionId: 'original-provider-session' }
            if (driverOwned) { yield { type: 'step-boundary' }; return }
            yield { type: 'tool-event', toolName: 'test', callId: 'first', status: 'completed' }
            yield { type: 'tool-event', toolName: 'test', callId: 'second', status: 'completed' }
          }
          yield { type: 'text-delta', text: input.resumeSegmentedTurn || calls.length === 1 ? 'Old result' : input.prompt }
          yield { type: 'finish', reason: 'stop' }
        } finally { released++ }
      },
    } as never])
    const input = { adapterId: 'test', sessionId: 'session', prompt: 'Original task', messages: [human], splitToolSteps: true }
    const collect = async (value: typeof input & { peerInput?: boolean }) => {
      const events = []
      for await (const event of registry.execute(value)) events.push(event)
      return events
    }
    try {
      assert.equal((await collect(input)).at(-1)?.type, 'step-boundary')
      const next = await collect({ ...input, prompt: 'Fix the race', messages: [peer('fresh', 'Fix the race')], peerInput: true })
      if (!driverOwned) {
        assert.equal(next.at(-1)?.type, 'step-boundary')
        assert.equal(calls.length, 1, 'A peer turn must not run alongside the retained provider turn')
      }
      const final = driverOwned ? next : await collect(input)
      assert.deepEqual(final.filter(event => event.type === 'text-delta').map(event => event.text), ['Old result', 'Fix the race'])
      assert.equal(final.filter(event => event.type === 'finish').length, 1)
      assert.equal(calls.at(-1)?.providerSessionId, 'original-provider-session')
      assert.equal(calls.at(-1)?.resumeSegmentedTurn, false)
      assert.equal(calls.filter(call => call.peerInput && !call.resumeSegmentedTurn).length, 1)
      assert.equal(calls.length, driverOwned ? 3 : 2)
      assert.equal(released, calls.length)
    } finally { await registry.dispose() }
  })
}

test('failed suspended turns do not automatically run pending peer work', async () => {
  let calls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'test', name: 'Test' },
    executeTurn: async function* () {
      calls++
      yield { type: 'tool-event', toolName: 'test', callId: 'one', status: 'completed' }
      yield { type: 'finish', reason: 'error' }
    },
  } as never])
  const input = { adapterId: 'test', sessionId: 'session', prompt: 'Original', messages: [], splitToolSteps: true }
  try {
    for await (const _event of registry.execute(input)) { /* reach boundary */ }
    await assert.rejects(async () => {
      for await (const _event of registry.execute({ ...input, prompt: 'New peer work', peerInput: true })) { /* consume */ }
    }, { code: 'TEAM_DELIVERY_UNCERTAIN' })
    assert.equal(calls, 1)
  } finally { await registry.dispose() }
})

test('a native Lead tool-only response retains its tool-call finish reason', async () => {
  let listener: any
  const registry = new CodingNsCliAdapterRegistry([])
  const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(), events: { on(name: string, callback: unknown) { if (name === 'llm/stream') listener = callback; return () => {} } } })
  features.register(createCliAdaptersFeature({ registry }) as never)
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'spawn', name: 'agent_team', argumentsDelta: '{"action":"members"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'spawn', name: 'agent_team', arguments: '{"action":"members"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  try {
    await features.start('cliAdapters')
    const actual = []
    for await (const chunk of listener({ sessionId: 'native-lead', messages: [] }, async function* () { yield* chunks })) actual.push(chunk)
    assert.deepEqual(actual, chunks)
  } finally { await features.disable('cliAdapters') }
})

test('switching a native session to an external participant does not replay prior human inputs', async () => {
  let listener: any
  const hooks = new Map<string, any>(); const inputs: any[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Test' },
    detect: async () => ({ installed: true, version: 'test', command: 'fake' }),
    executeTurn: async function* (input: unknown) { inputs.push(input); yield { type: 'text-delta', text: 'Done' }; yield { type: 'finish', reason: 'stop' } },
  } as never])
  const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(),
    dshContext: { get: () => undefined, on(name: string, callback: unknown) { hooks.set(name, callback); return () => {} } } as never,
    events: { on(name: string, callback: unknown) { if (name === 'llm/stream') listener = callback; return () => {} } },
  })
  features.register(createCliAdaptersFeature({ registry }) as never)
  try {
    await features.start('cliAdapters')
    const preStep = hooks.get('agent/pre-step')
    const agent = { id: 'switch' }
    await preStep({ agent, messages: [human] }, async () => ({ kind: 'enter', messages: [human] }))
    registry.setSession('switch', { adapterId: 'codex' })
    const fresh = peer('fresh', 'Only this new work')
    await preStep({ agent, messages: [fresh] }, async () => ({ kind: 'enter', messages: [fresh] }))
    for await (const _event of listener({ sessionId: 'switch', messages: [human, { role: 'assistant', content: 'Old result' }, fresh] }, async function* () { throw new Error('Unexpected native stream') })) { /* consume */ }
    assert.equal(inputs[0].prompt, fresh.content)
  } finally { await features.disable('cliAdapters') }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../src/host/cli-adapters/session-store.js'
import { resolveNativeApprovalPermission } from '../src/shared/native-approval-modes.js'
import type { CodingNsCliTurnInput } from '../src/shared/contracts/cli-adapter.js'

const drain = async (stream: AsyncIterable<unknown>) => { for await (const _event of stream) {} }
const manual = { nativeApprovalMode: 'manual', sandboxMode: 'workspace-write', approvalPolicy: 'ask' } as const

for (const [adapterId, nextMode] of [['codex', 'full-access'], ['zcode', 'full-access'], ['codex', 'full-access-confirm']] as const) test(`${adapterId}: save ${nextMode} while running, preserve the current turn and late binding, apply next turn`, async () => {
  let started!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const received: CodingNsCliTurnInput[] = []
  let approvalActivations = 0
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: adapterId, name: adapterId }, detect: async () => ({ installed: true, version: null, command: null }),
    async *executeTurn(input: CodingNsCliTurnInput) {
      received.push(input)
      if (received.length === 1) { started(); await gate; yield { type: 'session-binding', providerSessionId: 'late-native-binding' } as const }
      yield { type: 'finish', reason: 'stop' } as const
    },
  }] as never, {}, { sessionStore: store, nativeSessions: { ensure: async () => null, enableInteractiveApproval() { approvalActivations++; return true } } as never })
  registry.setSession('running', { adapterId, nativeApprovalMode: 'manual' })
  const running = drain(registry.execute({ adapterId, sessionId: 'running', messages: [], prompt: 'first', permission: manual }))
  try {
    await reached
    registry.setSession('running', { adapterId, nativeApprovalMode: nextMode })
    assert.equal(registry.getSession('running').nativeApprovalMode, nextMode)
    assert.equal(approvalActivations, 0)
    assert.deepEqual(received[0].permission, manual, 'current execution retains its original permission snapshot')
    release(); await running
    assert.equal(registry.getSession('running').nativeApprovalMode, nextMode, 'late provider binding cannot overwrite the saved choice')
    assert.equal(registry.getSession('running').providerSessionId, 'late-native-binding')
    assert.equal(store.get('running')?.nativeApprovalMode, nextMode)
    const next = resolveNativeApprovalPermission(registry.getSession('running'), {})
    await drain(registry.execute({ adapterId, sessionId: 'running', messages: [], prompt: 'next', ...(next ? { permission: next } : {}) }))
    assert.equal(received[1].permission?.nativeApprovalMode, nextMode)
    assert.equal(approvalActivations, nextMode === 'full-access-confirm' ? 1 : 0)
    assert.equal(registry.setSession('new-session', { adapterId }).nativeApprovalMode, nextMode, 'new conversations remember the saved choice')
  } finally { release(); await running; await registry.dispose() }
})

for (const nextMode of ['full-access', 'full-access-confirm'] as const) for (const initial of [manual, undefined]) test(`driver-owned segments retain the original permission snapshot for ${nextMode} (known=${initial !== undefined})`, async () => {
  const permissions: Array<CodingNsCliTurnInput['permission']> = []
  let approvalActivations = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' }, supportsSegmentedTurns: true,
    detect: async () => ({ installed: true, version: null, command: null }),
    async *executeTurn(input: CodingNsCliTurnInput) {
      permissions.push(input.permission)
      yield permissions.length === 3 ? { type: 'finish', reason: 'stop' } as const : { type: 'step-boundary' } as const
    },
  }] as never, {}, { nativeSessions: { ensure: async () => null, enableInteractiveApproval() { approvalActivations++; return true } } as never })
  const input = { adapterId: 'codex', sessionId: 'segmented', messages: [], prompt: 'first', splitToolSteps: true, ...(initial ? { permission: initial } : {}) }
  try {
    registry.setSession('segmented', { adapterId: 'codex', nativeApprovalMode: 'manual' })
    await drain(registry.execute(input))
    registry.setSession('segmented', { adapterId: 'codex', nativeApprovalMode: nextMode })
    const next = resolveNativeApprovalPermission(registry.getSession('segmented'), {})!
    await drain(registry.execute({ ...input, permission: next }))
    assert.deepEqual(permissions[1], initial, 'a DSH step boundary is not a new user turn')
    await drain(registry.execute({ ...input, permission: next }))
    assert.deepEqual(permissions[2], initial, 'repeated DSH boundaries retain the original snapshot')
    assert.equal(approvalActivations, 0, 'saving and resuming cannot activate the next policy')
    await drain(registry.execute({ ...input, prompt: 'next user turn', permission: next }))
    assert.equal(permissions[3]?.nativeApprovalMode, nextMode)
    assert.equal(approvalActivations, nextMode === 'full-access-confirm' ? 1 : 0)
  } finally { await registry.dispose() }
})

for (const streamBoundary of [true, false]) for (const initial of [manual, undefined]) test(`held streams and deferred peer input keep the current permission (explicitBoundary=${streamBoundary}, known=${initial !== undefined})`, async () => {
  const received: CodingNsCliTurnInput[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' }, supportsStreamStepSplitting: streamBoundary,
    detect: async () => ({ installed: true, version: null, command: null }),
    async *executeTurn(input: CodingNsCliTurnInput) {
      received.push(input)
      if (received.length === 1) yield streamBoundary ? { type: 'step-boundary' } as const : { type: 'tool-event', toolName: 'shell', callId: 'tool-1', status: 'completed' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }] as never)
  const input = { adapterId: 'codex', sessionId: 'stream', messages: [], prompt: 'first', splitToolSteps: true, ...(initial ? { permission: initial } : {}) }
  try {
    registry.setSession('stream', { adapterId: 'codex', nativeApprovalMode: 'manual' })
    await drain(registry.execute(input))
    registry.setSession('stream', { adapterId: 'codex', nativeApprovalMode: 'full-access' })
    const next = resolveNativeApprovalPermission(registry.getSession('stream'), {})!
    await drain(registry.execute({ ...input, prompt: 'peer input in the same turn', permission: next, peerInput: true }))
    assert.equal(received.length, 2)
    assert.deepEqual(received[1].permission, initial, 'deferred peer input is part of the existing logical turn')
    await drain(registry.execute({ ...input, prompt: 'new user turn', permission: next }))
    assert.equal(received[2].permission?.nativeApprovalMode, 'full-access')
  } finally { await registry.dispose() }
})

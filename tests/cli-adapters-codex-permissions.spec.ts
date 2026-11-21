import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTick } from 'node:timers/promises'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { createCodingNsNativeSessionBridge, type CodingNsNativeApprovalOutcome } from '../data/build/dist/host/native-session-bridge.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'

const requestedPermissions = { fileSystem: { write: ['/workspace/approval-probe.txt'] } }

/**
 * 在内存中运行插件入口、Registry、Codex 驱动、投影层和原生审批桥接。
 * 外部运行时仅在权限工具已启用时发送请求，避免直接注入请求掩盖启动参数缺失。
 * 文件操作用状态记录，测试不会启动真实进程或修改工作区外文件。
 */
async function createPermissionHarness(segmented: boolean, approvalAvailable = true, nativeApprovalMode?: string,
  options: { command?: boolean; policy?: 'ask' | 'never'; policySetter?: boolean } = {}) {
  const sessionId = `codex-permission-${segmented}-${approvalAvailable}`
  const session = { id: sessionId, header: { cwd: '/workspace/repo' } }
  const agent = { id: sessionId, session }
  const state = {
    args: [] as string[],
    rpcCalls: [] as Array<{ id?: number; method?: string; params?: Record<string, any>; result?: any }>,
    approvals: [] as Array<{ agent: unknown; callId?: string; reason?: string }>,
    reply: undefined as Record<string, any> | undefined,
    executed: false,
    finished: false,
    policy: options.policy ?? 'ask' as 'ask' | 'never',
    policyChanges: [] as Array<'ask' | 'never'>,
  }
  let decide!: (outcome: CodingNsNativeApprovalOutcome) => void
  let markApprovalReached!: () => void
  const decision = new Promise<CodingNsNativeApprovalOutcome>((resolve) => { decide = resolve })
  const approvalReached = new Promise<void>((resolve) => { markApprovalReached = resolve })
  const preset = () => options.policy !== 'never' ? 'workspace-write' : state.policy === 'never' ? 'danger-full-access' : 'custom'
  const nativeApproval = {
    config: { policy: 'ask' },
    overrideOf: () => state.policy,
    effectivePolicy: () => state.policy,
    ...(options.policySetter === false ? {} : { setPolicy(target: unknown, policy: 'ask' | 'never') {
      assert.equal(target, agent)
      state.policy = policy
      state.policyChanges.push(policy)
    } }),
    async request(request: { agent: unknown; callId?: string; reason?: string }) {
      if (state.policy === 'never') return 'rejected'
      state.approvals.push(request)
      markApprovalReached()
      return decision
    },
  }
  const dshContext = { get(name: string): unknown {
    if (name === 'agents') return { get: (id: string) => id === sessionId ? agent : undefined }
    if (name === 'sandboxPolicy') return { resolve: ({ session: target }: { session: unknown }) => {
      assert.equal(target, session)
      return { mode: options.policy === 'never' ? 'danger-full-access' : 'workspace-write', workspaceRoot: '/workspace/repo' }
    } }
    if (name === 'permissionPresets') return { current: preset }
    if (name === 'approval' && approvalAvailable) return nativeApproval
    return undefined
  } }
  const bridge = createCodingNsNativeSessionBridge(dshContext as never)
  const nativeSessions = {
    ...bridge,
    available: segmented,
    get: () => session,
    canInjectNextStep: () => true,
    injectNextStep: () => true,
  }
  const spawn = (_command: string, args: string[]) => {
    state.args = args
    // Windows 的 cmd /c 会把 CLI 参数包装成一个带引号的命令字符串。
    const cliArgs = args.flatMap((arg) => arg.replace(/"/gu, '').split(/\s+/u))
    const permissionToolEnabled = cliArgs.includes('features.request_permissions_tool=true')
      || cliArgs.some((arg, index) => arg === '--enable' && cliArgs[index + 1] === 'request_permissions_tool')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`) }
    const complete = (): void => send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId: 'permission-thread', turn: { id: 'permission-turn', status: 'completed' },
    } })
    const write = (data: string): void => {
      const request = JSON.parse(data) as (typeof state.rpcCalls)[number]
      state.rpcCalls.push(request)
      if (request.method === undefined && request.id === 77) {
        state.reply = request.result
        state.executed = options.command ? request.result?.decision === 'accept'
          : request.result?.permissions?.fileSystem?.write?.includes('/workspace/approval-probe.txt') === true
        complete()
        return
      }
      if (request.method === 'initialized') return
      const result = request.method === 'thread/start' ? { thread: { id: 'permission-thread' } }
        : request.method === 'turn/start' ? { turn: { id: 'permission-turn', status: 'inProgress' } }
        : request.method === 'model/list' ? { data: [] } : {}
      send({ jsonrpc: '2.0', id: request.id, result })
      if (request.method !== 'turn/start') return
      if (!permissionToolEnabled && !options.command) {
        complete()
        return
      }
      send({ jsonrpc: '2.0', id: 77, method: options.command ? 'item/commandExecution/requestApproval' : 'item/permissions/requestApproval', params: {
        threadId: 'permission-thread', turnId: 'permission-turn', itemId: 'permission-item',
        environmentId: 'local', cwd: '/workspace/repo', reason: '测试工作区外写入权限',
        ...(options.command ? { command: 'pwsh.exe -Command "Remove-Item -LiteralPath fixture -Force"', availableDecisions: ['accept', 'decline'] }
          : { permissions: requestedPermissions }),
      } })
    }
    return { stdout, stderr, stdin: { write }, kill() { stdout.end(); stderr.end(); return true } }
  }
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.160.0', stderr: '' })) as never,
    spawn: spawn as never,
  })
  const registry = new CodingNsCliAdapterRegistry([driver], {}, { nativeSessions })
  const rpc = new CodingNsRpcTable()
  let listener!: (input: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<Record<string, unknown>>
  const events = { on(name: string, next: typeof listener) {
    if (name === 'llm/stream') listener = next
    return () => {}
  } }
  const features = new FeatureRegistry({ rpc, events, nativeSessions, dshContext: dshContext as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await rpc.resolve('cli/session/set')?.handler('session/set', { sessionId, adapterId: 'codex', ...(nativeApprovalMode ? { nativeApprovalMode } : {}) })
  const chunks: Record<string, unknown>[] = []
  const run = async (next: () => AsyncIterable<unknown> = async function* () {}) => {
    // 用户只表达测试意图，不提供提权参数或测试文件路径。
    for await (const chunk of listener({ sessionId, messages: [{ role: 'user', content: '请触发权限申请并验证我的选择' }] }, next)) chunks.push(chunk)
    state.finished = true
  }
  const running = run()
  return {
    state, agent, chunks, running, approvalReached, decide, run, rpc, sessionId, nativeApproval, preset,
    async dispose() {
      decide('cancelled')
      try { await running } finally { await features.disable('cliAdapters') }
    },
  }
}

for (const segmented of [false, true]) for (const outcome of ['allowed-once', 'rejected', 'cancelled'] as const) {
  test(`Codex full-access-confirm ${segmented ? 'segmented' : 'ordinary'} command waits for ${outcome} after a never preset`, { timeout: 5_000 }, async () => {
    const harness = await createPermissionHarness(segmented, true, 'full-access-confirm', { command: true, policy: 'never' })
    try {
      await Promise.race([harness.approvalReached, harness.running.then(() => { throw new Error('Turn ended before native command approval') })])
      assert.deepEqual(harness.state.policyChanges, ['ask', 'never'])
      assert.equal(harness.state.policy, 'never', 'restore before the user answers')
      assert.equal(harness.state.executed, false)
      assert.equal(harness.state.finished, false)
      assert.equal(harness.state.reply, undefined)
      for (const method of ['thread/start', 'turn/start']) {
        const params = harness.state.rpcCalls.find(call => call.method === method)?.params
        assert.equal(params?.approvalPolicy, 'on-request')
        assert.equal(params?.approvalsReviewer, 'user')
        assert.equal(method === 'thread/start' ? params?.sandbox : params?.sandboxPolicy.type, method === 'thread/start' ? 'danger-full-access' : 'dangerFullAccess')
      }
      const launch = harness.state.args.join(' ').replace(/"/gu, '')
      assert.match(launch, /sandbox_mode=danger-full-access/u)
      assert.match(launch, /approval_policy=on-request/u)
      harness.decide(outcome)
      await harness.running
      assert.deepEqual(harness.state.reply, { decision: outcome === 'allowed-once' ? 'accept' : 'decline' })
      assert.equal(harness.state.executed, outcome === 'allowed-once')
      assert.equal(harness.chunks.at(-1)?.type, 'finish')
    } finally { await harness.dispose() }
  })
}

test('Codex full-access-confirm fails before CLI launch without a restorable native policy', { timeout: 5_000 }, async () => {
  const harness = await createPermissionHarness(false, true, 'full-access-confirm', { command: true, policy: 'never', policySetter: false })
  try {
    await harness.running
    assert.deepEqual(harness.state.policyChanges, [])
    assert.equal(harness.state.executed, false)
    assert.equal(harness.state.rpcCalls.length, 0)
    assert.equal(harness.state.approvals.length, 0)
    assert.match(JSON.stringify(harness.chunks), /DSH interactive approval is unavailable/u)
  } finally { await harness.dispose() }
})

for (const exit of ['dsh', 'full-access'] as const) {
  test(`same session: never → Codex full-access-confirm → ${exit} leaves the original DSH preset`, { timeout: 5_000 }, async () => {
    const harness = await createPermissionHarness(false, true, 'full-access-confirm', { command: true, policy: 'never' })
    try {
      await harness.approvalReached
      harness.decide('allowed-once')
      await harness.running
      assert.equal(harness.state.executed, true)
      const set = harness.rpc.resolve('cli/session/set')!.handler
      const saved = await set('session/set', exit === 'dsh'
        ? { sessionId: harness.sessionId, adapterId: 'dsh' }
        : { sessionId: harness.sessionId, adapterId: 'codex', nativeApprovalMode: exit })
      assert.equal('nativeApprovalMode' in (saved as object), exit !== 'dsh')
      assert.equal(harness.preset(), 'danger-full-access')
      assert.equal(harness.nativeApproval.overrideOf(), 'never')
      if (exit === 'dsh') {
        const native = async function* () {
          assert.equal(await harness.nativeApproval.request({ agent: harness.agent, callId: 'native-tool' }), 'rejected')
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'native-result' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native-result' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        await harness.run(native)
        assert.equal(harness.chunks.at(-2)?.type, 'block-end')
        assert.deepEqual(harness.chunks.at(-2)?.block, { type: 'text', text: 'native-result' })
        assert.deepEqual(harness.chunks.at(-1)?.reason, { kind: 'stop' })
      }
      assert.equal(harness.state.approvals.length, 1, 'native approval must not show another prompt')
      assert.deepEqual(harness.state.policyChanges, ['ask', 'never'], 'switching does not write another native policy')
    } finally { await harness.dispose() }
  })
}

for (const segmented of [false, true]) {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled'] as const) {
    test(`Codex 插件原生权限工具${segmented ? '分段' : '普通'}回合等待 DSH ${outcome} 并应用决定`, { timeout: 5_000 }, async () => {
      const harness = await createPermissionHarness(segmented)
      try {
        await Promise.race([
          harness.approvalReached,
          harness.running.then(() => { throw new Error('插件回合在触发 DSH 审批之前结束，原生权限工具未接入') }),
        ])
        await nextTick()
        const { state } = harness
        assert.equal(state.finished, false)
        assert.equal(state.reply, undefined)
        assert.equal(state.executed, false)
        assert.equal(state.approvals.length, 1)
        assert.equal(state.approvals[0]?.agent, harness.agent)
        assert.equal(state.approvals[0]?.callId, 'permission-item')
        assert.match(state.approvals[0]?.reason ?? '', /\/workspace\/approval-probe\.txt/u)
        const thread = state.rpcCalls.find((call) => call.method === 'thread/start')?.params
        const turn = state.rpcCalls.find((call) => call.method === 'turn/start')?.params
        assert.equal(thread?.sandbox, 'workspace-write')
        assert.equal(thread?.approvalPolicy, 'on-request')
        assert.equal(turn?.approvalPolicy, 'on-request')
        assert.deepEqual(turn?.sandboxPolicy.writableRoots, [resolve('/workspace/repo')])
        assert.match(thread?.developerInstructions ?? '', /request_permissions/u)
        assert.match(thread?.developerInstructions ?? '', /实际授予/u)
        harness.decide(outcome)
        await harness.running
        assert.deepEqual(state.reply, {
          permissions: outcome === 'allowed-once' ? requestedPermissions : {}, scope: 'turn',
        })
        assert.equal(state.executed, outcome === 'allowed-once')
        assert.equal(harness.chunks.at(-1)?.type, 'finish')
      } finally {
        await harness.dispose()
      }
    })
  }

  test(`Codex 插件${segmented ? '分段' : '普通'}回合在 DSH 审批服务缺失时不给予额外权限`, { timeout: 5_000 }, async () => {
    const harness = await createPermissionHarness(segmented, false)
    try {
      await harness.running
      assert.deepEqual(harness.state.reply, { permissions: {}, scope: 'turn' })
      assert.equal(harness.state.executed, false)
      assert.equal(harness.state.approvals.length, 0)
      assert.equal(harness.chunks.at(-1)?.type, 'finish')
    } finally {
      await harness.dispose()
    }
  })
}


for (const [mode, reviewer] of [['auto-review', 'auto_review'], ['manual', 'user'], ['inherit', 'user']] as const) {
  test(`Codex UI 设置 ${mode} 通过真实 Host 链传给 thread 和 turn reviewer`, { timeout: 5000 }, async () => {
    const harness = await createPermissionHarness(false, true, mode)
    try {
      await harness.approvalReached
      for (const method of ['thread/start', 'turn/start']) {
        const params = harness.state.rpcCalls.find(call => call.method === method)?.params
        assert.equal(params?.approvalsReviewer, reviewer)
        assert.equal(params?.approvalPolicy, 'on-request')
        assert.equal(method === 'thread/start' ? params?.sandbox : params?.sandboxPolicy.type, method === 'thread/start' ? 'workspace-write' : 'workspaceWrite')
      }
    } finally { await harness.dispose() }
  })
}


test('Codex 同一 native thread 从自动审批切回人工再跟随，逐轮清除 reviewer 残留', { timeout: 5000 }, async () => {
  const harness = await createPermissionHarness(false, true, 'auto-review')
  try {
    await harness.approvalReached
    harness.decide('rejected'); await harness.running
    for (const mode of ['manual', 'auto-review', 'inherit']) {
      const saved: any = await harness.rpc.resolve('cli/session/set')?.handler('session/set', { sessionId: harness.sessionId, adapterId: 'codex', nativeApprovalMode: mode })
      assert.equal(saved.providerSessionId, 'permission-thread')
      await harness.run()
    }
    const turns = harness.state.rpcCalls.filter(call => call.method === 'turn/start')
    assert.deepEqual(turns.map(call => call.params?.approvalsReviewer), ['auto_review', 'user', 'auto_review', 'user'])
    assert.deepEqual([...new Set(turns.map(call => call.params?.threadId))], ['permission-thread'])
    assert.equal(harness.state.rpcCalls.filter(call => call.method === 'thread/start').length, 1)
  } finally { await harness.dispose() }
})

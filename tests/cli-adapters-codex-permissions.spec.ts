import assert from 'node:assert/strict'
import test from 'node:test'
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
async function createPermissionHarness(segmented: boolean, approvalAvailable = true) {
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
  }
  let decide!: (outcome: CodingNsNativeApprovalOutcome) => void
  let markApprovalReached!: () => void
  const decision = new Promise<CodingNsNativeApprovalOutcome>((resolve) => { decide = resolve })
  const approvalReached = new Promise<void>((resolve) => { markApprovalReached = resolve })
  const dshContext = { get(name: string): unknown {
    if (name === 'agents') return { get: (id: string) => id === sessionId ? agent : undefined }
    if (name === 'sandboxPolicy') return { resolve: ({ session: target }: { session: unknown }) => {
      assert.equal(target, session)
      return { mode: 'workspace-write', workspaceRoot: '/workspace/repo' }
    } }
    if (name === 'permissionPresets') return { current: () => 'workspace-write' }
    if (name === 'approval' && approvalAvailable) return {
      config: { policy: 'ask' },
      overrideOf: () => 'ask',
      async request(request: { agent: unknown; callId?: string; reason?: string }) {
        state.approvals.push(request)
        markApprovalReached()
        return decision
      },
    }
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
    const permissionToolEnabled = args.includes('features.request_permissions_tool=true')
      || args.some((arg, index) => arg === '--enable' && args[index + 1] === 'request_permissions_tool')
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
        state.executed = request.result?.permissions?.fileSystem?.write?.includes('/workspace/approval-probe.txt') === true
        complete()
        return
      }
      if (request.method === 'initialized') return
      const result = request.method === 'thread/start' ? { thread: { id: 'permission-thread' } }
        : request.method === 'turn/start' ? { turn: { id: 'permission-turn', status: 'inProgress' } }
        : request.method === 'model/list' ? { data: [] } : {}
      send({ jsonrpc: '2.0', id: request.id, result })
      if (request.method !== 'turn/start') return
      if (!permissionToolEnabled) {
        complete()
        return
      }
      send({ jsonrpc: '2.0', id: 77, method: 'item/permissions/requestApproval', params: {
        threadId: 'permission-thread', turnId: 'permission-turn', itemId: 'permission-item',
        environmentId: 'local', cwd: '/workspace/repo', reason: '测试工作区外写入权限',
        permissions: requestedPermissions,
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
  await rpc.resolve('cli/session/set')?.handler('session/set', { sessionId, adapterId: 'codex' })
  const chunks: Record<string, unknown>[] = []
  const running = (async () => {
    // 用户只表达测试意图，不提供提权参数或测试文件路径。
    for await (const chunk of listener({ sessionId, messages: [{ role: 'user', content: '请触发权限申请并验证我的选择' }] }, async function* () {})) chunks.push(chunk)
    state.finished = true
  })()
  return {
    state, agent, chunks, running, approvalReached, decide,
    async dispose() {
      decide('cancelled')
      try { await running } finally { await features.disable('cliAdapters') }
    },
  }
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
        assert.deepEqual(turn?.sandboxPolicy.writableRoots, ['/workspace/repo'])
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

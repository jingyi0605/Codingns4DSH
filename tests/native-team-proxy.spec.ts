import assert from 'node:assert/strict'
import test from 'node:test'
import { DshNativeTeamProxy } from '../data/build/dist/host/cli-adapters/native-team-proxy.js'

test('原生 Team Proxy 按 sessionId 解析 Agent 并转发 roster 操作', async () => {
  const agent = { id: 'session-1', session: { id: 'session-1' } }
  const calls: unknown[][] = []
  const proxy = new DshNativeTeamProxy({
    listMembers(current) {
      calls.push(['listMembers', current])
      return [{ id: 'session-1', role: 'lead' }]
    },
    spawnTeammate(current, request) {
      calls.push(['spawnTeammate', current, request])
      return Promise.resolve({ member: { id: 'child-1' } })
    },
  }, { get: (id) => id === 'session-1' ? agent : undefined, list: () => [agent] })

  assert.deepEqual(proxy.diagnostic(), {
    supported: true,
    code: 'DSH_TEAM_PROXY_READY',
    message: 'DSH 0.2 原生 Agent Team 已通过 Codingns4DSH Proxy 暴露。',
  })
  assert.deepEqual(proxy.invoke('members', { sessionId: 'session-1' }), [{ id: 'session-1', role: 'lead' }])
  const result = await proxy.invoke('spawn', { sessionId: 'session-1', name: 'reviewer', description: 'review', prompt: [], context: 'fresh', provider: 'deepseek' })
  assert.deepEqual(result, { member: { id: 'child-1' } })
  assert.equal(calls[0]?.[0], 'listMembers')
  assert.equal(calls[1]?.[0], 'spawnTeammate')
})

test('没有原生 Team 或 Agent 时明确降级且拒绝调用', () => {
  const proxy = new DshNativeTeamProxy(undefined, undefined)
  assert.equal(proxy.diagnostic().supported, false)
  assert.equal(proxy.diagnostic().code, 'DSH_TEAM_NATIVE_UNAVAILABLE')
  assert.throws(() => proxy.invoke('members', { sessionId: 'session-1' }), /DSH_TEAM_NATIVE_UNAVAILABLE/u)
})

// 官方 TeamService 的方法依赖 this（spawnTeammate 读 this.roster）。把方法从服务
// 对象上取出后解绑调用会抛 "Cannot read properties of undefined (reading 'roster')"，
// 因此 Proxy 必须用 apply 保留 owner。这里用依赖 this 的服务复现真实形状。
test('原生 Team Proxy 转发时保留 TeamService 的 this 绑定', async () => {
  const agent = { id: 'session-1', session: { id: 'session-1' } }
  const service = {
    roster: { spawn: (request: { name: string }) => ({ member: { id: `child-${request.name}` } }) },
    membership(current: unknown) {
      assert.equal(this.roster !== undefined, true)
      return { role: 'lead', current }
    },
    listMembers() {
      assert.equal(this.roster !== undefined, true)
      return [{ id: 'session-1', role: 'lead' }]
    },
    async spawnTeammate(_current: unknown, request: { name: string }) {
      assert.equal(this.roster !== undefined, true)
      return await this.roster.spawn(request)
    },
  }
  const proxy = new DshNativeTeamProxy(service, { get: (id) => id === 'session-1' ? agent : undefined, list: () => [agent] })
  const status = proxy.invoke('status', { sessionId: 'session-1' }) as { membership: unknown }
  assert.deepEqual(status.membership, { role: 'lead', current: agent })
  assert.deepEqual(proxy.invoke('members', { sessionId: 'session-1' }), [{ id: 'session-1', role: 'lead' }])
  const spawned = await proxy.invoke('spawn', { sessionId: 'session-1', name: 'reviewer' })
  assert.deepEqual(spawned, { member: { id: 'child-reviewer' } })
})

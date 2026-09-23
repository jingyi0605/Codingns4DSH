import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEBUG_ERROR_CODES,
  DEBUG_RPC_ENDPOINTS,
  parseDebugMutationScope,
  parseDebugPtyLaunchRequest,
  parseDebugRpcScope,
} from '../dist/shared/index.js'

test('阶段 0 冻结 Debug RPC 清单和状态边界', () => {
  assert.equal(DEBUG_RPC_ENDPOINTS[0], 'debug/snapshot')
  assert.ok(DEBUG_RPC_ENDPOINTS.includes('debug/runtime/start'))
  assert.ok(DEBUG_RPC_ENDPOINTS.includes('debug/runtime/stop'))
  assert.ok(DEBUG_RPC_ENDPOINTS.includes('debug/proxy/enable'))
  assert.equal(DEBUG_ERROR_CODES.GENERATION_STALE, 'DEBUG_GENERATION_STALE')
  assert.equal(DEBUG_ERROR_CODES.DSH_HOST_API_UNAVAILABLE, 'DEBUG_DSH_HOST_API_UNAVAILABLE')
})

test('Debug RPC 作用域只接受非空标识和非负 generation', () => {
  assert.deepEqual(parseDebugRpcScope({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 2,
  }), {
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 2,
  })
  assert.throws(() => parseDebugRpcScope({ sessionId: '', workspaceId: 'workspace-a', generation: 0 }), /sessionId/u)
  assert.throws(() => parseDebugRpcScope({ sessionId: 'session-a', workspaceId: 'workspace-a', generation: -1 }), /generation/u)
  assert.throws(() => parseDebugRpcScope({ sessionId: 'session-a', workspaceId: 'workspace-a', generation: 1.5 }), /generation/u)
})

test('Debug 写请求不允许同时使用两个并发版本字段', () => {
  assert.deepEqual(parseDebugMutationScope({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 0,
    recordId: 'profile-a',
    expectedRevision: 3,
  }).expectedRevision, 3)
  assert.throws(() => parseDebugMutationScope({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 0,
    recordId: 'profile-a',
    expectedRevision: 3,
    expectedUpdatedAt: '2026-09-23T00:00:00.000Z',
  }), /只能提供一个/u)
})

test('PTY 启动请求只接受受限尺寸和启动项标识', () => {
  assert.deepEqual(parseDebugPtyLaunchRequest({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 1,
    profileId: 'profile-a',
    cols: 120,
    rows: 32,
  }).profileId, 'profile-a')
  assert.throws(() => parseDebugPtyLaunchRequest({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 1,
    profileId: 'profile-a',
    cols: 501,
    rows: 32,
  }), /尺寸/u)
  assert.throws(() => parseDebugPtyLaunchRequest({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    generation: 1,
    profileId: 'profile-a',
    cols: 120,
    rows: 32,
    cwd: '/绝对路径',
  }), /未知字段/u)
})

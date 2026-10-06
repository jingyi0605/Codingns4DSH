import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAssistantScope,
  filterAssistantSessions,
  filterSessionsByAssistantScope,
  getAssistantScopeRejection,
  getAssistantScopeState,
  isAssistantScopeEmpty,
  isAssistantScopeTargetAllowed,
  type AssistantScopeSession,
} from '../data/build/dist/host/features/assistant-scope.js'

interface Session extends AssistantScopeSession {
  readonly title: string
}

const sessions: readonly Session[] = [
  { sessionId: 'a-1', workspaceId: 'workspace-a', title: 'A / 1' },
  { sessionId: 'a-2', workspaceId: 'workspace-a', title: 'A / 2' },
  { sessionId: 'b-1', workspaceId: 'workspace-b', title: 'B / 1' },
  { sessionId: 'c-1', workspaceId: 'workspace-c', title: 'C / 1' },
]

test('创建范围会去空白、去重并固定排除归档会话', () => {
  const input = [' workspace-a ', '', 'workspace-b', 'workspace-a', '   ']
  const scope = createAssistantScope(input)

  assert.deepEqual(scope, {
    managedWorkspaceIds: ['workspace-a', 'workspace-b'],
    includeArchived: false,
  })
  assert.deepEqual(input, [' workspace-a ', '', 'workspace-b', 'workspace-a', '   '])
  assert.equal(isAssistantScopeEmpty(scope), false)
})

test('空范围保留明确状态，并拒绝目标', () => {
  const scope = createAssistantScope([])
  const result = filterAssistantSessions(sessions, scope, [])

  assert.deepEqual(getAssistantScopeState(scope), {
    status: 'empty',
    reason: 'no-managed-workspaces',
    message: '尚未选择任何工作区',
  })
  assert.deepEqual(result, {
    state: {
      status: 'empty',
      reason: 'no-managed-workspaces',
      message: '尚未选择任何工作区',
    },
    sessions: [],
  })
  assert.deepEqual(getAssistantScopeRejection(scope, { workspaceId: 'workspace-a', sessionId: 'a-1' }, []), {
    code: 'scope-empty',
    message: '尚未选择任何工作区，无法访问会话；请打开全局智能助理设置并勾选工作区后重试',
  })
  assert.equal(isAssistantScopeTargetAllowed(scope, { workspaceId: 'workspace-a' }, []), false)
})

test('单工作区只返回该工作区的未归档会话', () => {
  const scope = createAssistantScope(['workspace-a'])
  const visible = filterSessionsByAssistantScope(sessions, scope, ['a-2'])

  assert.deepEqual(visible, [sessions[0]])
  assert.deepEqual(getAssistantScopeState(scope), {
    status: 'ready',
    managedWorkspaceIds: ['workspace-a'],
  })
})

test('多工作区保留各工作区会话，并支持 Set 归档集合', () => {
  const scope = createAssistantScope(['workspace-a', 'workspace-b'])
  const visible = filterSessionsByAssistantScope(sessions, scope, new Set(['a-1']))

  assert.deepEqual(visible, [sessions[1], sessions[2]])
  assert.equal(visible.includes(sessions[3]), false)
})

test('全部归档时结果为空，取消归档后会重新纳入', () => {
  const scope = createAssistantScope(['workspace-a', 'workspace-b'])
  const archived = new Set(['a-1', 'a-2', 'b-1'])

  assert.deepEqual(filterSessionsByAssistantScope(sessions, scope, archived), [])
  archived.delete('a-2')
  assert.deepEqual(filterSessionsByAssistantScope(sessions, scope, archived), [sessions[1]])
})

test('范围外目标和已归档目标分别返回结构化拒绝原因', () => {
  const scope = createAssistantScope(['workspace-a'])

  assert.deepEqual(getAssistantScopeRejection(scope, { workspaceId: 'workspace-b', sessionId: 'b-1' }, ['b-1']), {
    code: 'workspace-outside-scope',
    workspaceId: 'workspace-b',
    message: '工作区「workspace-b」不在助理受管范围内；请打开全局智能助理设置并勾选该工作区后重试',
  })
  assert.deepEqual(getAssistantScopeRejection(scope, { workspaceId: 'workspace-a', sessionId: 'a-1' }, ['a-1']), {
    code: 'session-archived',
    sessionId: 'a-1',
    message: '会话「a-1」已归档，不在助理索引范围内',
  })
  assert.equal(isAssistantScopeTargetAllowed(scope, { workspaceId: 'workspace-a', sessionId: 'a-1' }, []), true)
})

test('过滤是纯函数，不修改会话数组、会话对象或归档集合', () => {
  const scope = createAssistantScope(['workspace-a'])
  const input = [...sessions]
  const archived = ['a-2']
  const inputSnapshot = [...input]
  const archivedSnapshot = [...archived]

  filterSessionsByAssistantScope(input, scope, archived)

  assert.deepEqual(input, inputSnapshot)
  assert.deepEqual(archived, archivedSnapshot)
  assert.strictEqual(input[0], sessions[0])
})

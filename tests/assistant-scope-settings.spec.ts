import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantScopeSettings } from '../data/build/dist/host/features/assistant-scope-settings.js'

test('首次加载默认空范围，空范围有明确状态', async () => {
  const writes: string[][] = []
  const settings = new AssistantScopeSettings({ read: () => [], write: (ids) => writes.push([...ids]) })
  const snapshot = await settings.load()
  assert.equal(snapshot.state.status, 'empty')
  assert.deepEqual(writes, [])
})
test('显式勾选与取消工作区会持久化并通知索引重建', async () => {
  const writes: string[][] = []
  const changes: string[][] = []
  const settings = new AssistantScopeSettings({ read: () => ['workspace-a'], write: (ids) => writes.push([...ids]) })
  settings.subscribe(({ scope }) => changes.push([...scope.managedWorkspaceIds]))
  await settings.load()
  await settings.setManagedWorkspaceIds(['workspace-a', 'workspace-b'])
  await settings.setManagedWorkspaceIds([])
  assert.deepEqual(writes, [['workspace-a', 'workspace-b'], []])
  assert.deepEqual(changes, [['workspace-a', 'workspace-b'], []])
})

test('设置层不修改调用方输入', async () => {
  const input = [' workspace-a ', 'workspace-a']
  const settings = new AssistantScopeSettings({ read: () => [], write: () => undefined })
  await settings.setManagedWorkspaceIds(input)
  assert.deepEqual(input, [' workspace-a ', 'workspace-a'])
  assert.deepEqual(settings.snapshot().scope.managedWorkspaceIds, ['workspace-a'])
})

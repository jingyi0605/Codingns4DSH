import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyGitWorkspaceChanged, subscribeGitWorkspaceChanged } from '../data/build/dist/client/git-workspace-events.js'

test('Git 工作区变更总线只通知对应工作区并支持取消订阅', () => {
  let workspaceOneNotifications = 0
  let workspaceTwoNotifications = 0
  const disposeOne = subscribeGitWorkspaceChanged('workspace-1', () => { workspaceOneNotifications += 1 })
  const disposeTwo = subscribeGitWorkspaceChanged('workspace-2', () => { workspaceTwoNotifications += 1 })

  notifyGitWorkspaceChanged('workspace-1')
  assert.equal(workspaceOneNotifications, 1)
  assert.equal(workspaceTwoNotifications, 0)

  disposeOne()
  notifyGitWorkspaceChanged('workspace-1')
  notifyGitWorkspaceChanged('workspace-2')
  assert.equal(workspaceOneNotifications, 1)
  assert.equal(workspaceTwoNotifications, 1)

  disposeTwo()
  notifyGitWorkspaceChanged('workspace-2')
  assert.equal(workspaceTwoNotifications, 1)
})

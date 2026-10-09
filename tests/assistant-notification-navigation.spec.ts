import assert from 'node:assert/strict'
import test from 'node:test'
import { HostRouter } from '../src/features/host-router.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { openAssistantNotificationSession, supportsAssistantSessionNavigation } from '../src/dsh-capabilities/client/assistant-session-navigation-adapter.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { AssistantNotificationTarget } from '../src/shared/assistant-notifications.js'

const target = (value: AssistantNotificationTarget, localHostId = 'entry-host'): AssistantNotificationTarget => ({ ...value, localHostId } as AssistantNotificationTarget)

function fixture(open: (id: string) => unknown = () => undefined) {
  const hostRouter = new HostRouter()
  const opened: string[] = []
  const uiContext = { get: (name: string) => name === 'uiWorkspace' ? { openSession(id: string) { opened.push(id); return open(id) } } : undefined }
  return { services: { hostRouter, uiContext } as Pick<CodingNsClientServices, 'hostRouter' | 'uiContext'>, opened }
}

test('同名本地与两个远端会话分别打开可信目标，当前选择不参与目标构造', async () => {
  const f = fixture()
  await f.services.hostRouter.switchTo({ hostId: 'old', targetHostId: 'old', workspaceId: 'old', sessionId: 'old' })
  for (const hostId of ['entry-host', 'host-a', 'host-b']) {
    await openAssistantNotificationSession(f.services, target({ hostId, workspaceId: 'project', sessionId: 'same' }))
    assert.equal(f.services.hostRouter.getCurrent()!.hostId, 'entry-host')
    assert.equal(f.services.hostRouter.getCurrent()!.targetHostId, hostId === 'entry-host' ? null : hostId)
    assert.equal(f.services.hostRouter.getCurrent()!.workspaceId, 'project')
  }
  assert.deepEqual(f.opened, ['same', createVirtualSessionId('host-a', 'same'), createVirtualSessionId('host-b', 'same')])
})

test('已有虚拟ID保持正确Host，跨Host错误或缺失能力直接失败且不回落本机', async () => {
  const f = fixture()
  const virtual = target({ hostId: 'remote', workspaceId: createVirtualWorkspaceId('remote', 'project'), sessionId: createVirtualSessionId('remote', 'same') })
  await openAssistantNotificationSession(f.services, virtual)
  assert.deepEqual(f.opened, [virtual.sessionId])
  await assert.rejects(openAssistantNotificationSession(f.services, { ...virtual, hostId: 'other' }), /身份不一致/u)
  assert.equal(f.opened.length, 1); assert.equal(supportsAssistantSessionNavigation(undefined), false)
  await assert.rejects(openAssistantNotificationSession({ hostRouter: new HostRouter() }, { hostId: 'local', workspaceId: 'project', sessionId: 'same' }), /不支持会话导航/u)
})

test('local-host及自定义本机身份不会编码成远端，local虚拟别名与旧远端范围可导航', async () => {
  const f = fixture()
  for (const localHostId of ['local-host', 'custom-entry']) {
    await openAssistantNotificationSession(f.services, target({ hostId: localHostId, workspaceId: 'project', sessionId: 'same' }, localHostId))
    assert.equal(f.services.hostRouter.getCurrent()!.targetHostId, null)
    assert.equal(f.services.hostRouter.getCurrent()!.hostId, localHostId)
    await openAssistantNotificationSession(f.services, target({ hostId: localHostId, workspaceId: createVirtualWorkspaceId('local', 'project'), sessionId: createVirtualSessionId('local', 'same') }, localHostId))
    assert.equal(f.services.hostRouter.getCurrent()!.targetHostId, null)
  }
  assert.deepEqual(f.opened, ['same', 'same', 'same', 'same'])
  await openAssistantNotificationSession(f.services, target({ hostId: 'peer', workspaceId: 'peer:project', sessionId: 'same' }, 'custom-entry'))
  assert.equal(f.services.hostRouter.getCurrent()!.workspaceId, 'project')
  assert.equal(f.services.hostRouter.getCurrent()!.targetHostId, 'peer')
  assert.equal(f.opened.at(-1), createVirtualSessionId('peer', 'same'))
})

test('导航失败、范围切换或取消期间不宣称成功，也不发送任何消息', async () => {
  const failed = fixture(() => false)
  await assert.rejects(openAssistantNotificationSession(failed.services, { hostId: 'local', workspaceId: 'project', sessionId: 'same' }), /未能打开/u)
  const cancel = new AbortController()
  const cancelled = fixture(() => { cancel.abort(); return undefined })
  await assert.rejects(openAssistantNotificationSession(cancelled.services, { hostId: 'remote', workspaceId: 'project', sessionId: 'same' }, cancel.signal), /abort/iu)
  const stale = fixture(async () => { await stale.services.hostRouter.clear() })
  await assert.rejects(openAssistantNotificationSession(stale.services, { hostId: 'remote', workspaceId: 'project', sessionId: 'same' }), /失效/u)
})

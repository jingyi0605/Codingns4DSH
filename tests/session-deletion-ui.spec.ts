import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSessionDeletionUiRefreshAdapter } from '../src/dsh-capabilities/client/session-deletion-adapter.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { CODINGNS_RPC_CHANNEL } from '../src/shared/contracts/transport.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import {
  SESSION_DELETION_MENU_ICON_KEY,
  SESSION_DELETION_ROW_ACTION_ID,
  SessionDeleteRowButton,
  SessionDeletionDialog,
  createSessionDeletionCoordinator,
  createSessionDeletionMenuProvider,
  parseSessionContextMenuTarget,
  startSessionDeletionUi,
} from '../src/client/session-deletion.js'
import { workspaceSessionEnhancementFeature } from '../src/client/features/workspace-session-enhancement.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { FeatureResourceScopeImpl } from '../src/features/registry.js'

const t = resolveCodingNsTranslator()

test('menu targets locate by exact clicked row sessionId even when titles match or row is in background', async () => {
  const rpcCalls: Array<{ endpoint: string; payload: unknown }> = []
  let clearedMain = false
  let refreshedId: string | undefined

  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(channel, endpoint, payload) {
        assert.equal(channel, CODINGNS_RPC_CHANNEL)
        rpcCalls.push({ endpoint, payload })
        if (endpoint === 'sessionDeletion/prepare') {
          const { sessionId } = payload as { sessionId: string }
          return {
            ok: true,
            value: {
              sessionId,
              title: 'Duplicate Title',
              mode: 'immediate',
              subagentStatus: 'none',
              activeReasons: [],
              operationId: 'op-bg-1',
              expiresAt: Date.now() + 60_000,
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: true,
                projectionCacheEnabled: true,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        return {
          ok: true,
          value: {
            operationId: 'op-bg-1',
            sessionId: 'session-background-b',
            status: 'deleted',
          },
        }
      },
    },
    uiRefresh: createSessionDeletionUiRefreshAdapter(
      {
        list: { getSnapshot: () => ({ byId: { 'session-main-a': { id: 'session-main-a', retainedBy: { mainView: 1 } } } }) },
        handleSessionRemoved(id: string) { refreshedId = id },
      },
      {
        mainReference: { sessionId: 'session-main-a' },
        clearMain() { clearedMain = true },
      },
    ),
  })

  const provider = createSessionDeletionMenuProvider({ coordinator })
  assert.equal(provider.target, 'session')

  const actions = provider.resolve({ sessionId: 'session-background-b', displayTitle: 'Duplicate Title' })
  assert.equal(actions.length, 1)
  await actions[0]!.run?.()

  assert.deepEqual(rpcCalls[0], { endpoint: 'sessionDeletion/prepare', payload: { sessionId: 'session-background-b' } })
  const stage = coordinator.getState()
  assert.equal(stage?.kind, 'ready')
  assert.equal(stage.sessionId, 'session-background-b')

  coordinator.setConfirmed(true)
  await coordinator.submitCommit()

  assert.equal(rpcCalls[1]?.endpoint, 'sessionDeletion/commit')
  assert.equal(clearedMain, false)
  assert.equal(refreshedId, 'session-background-b')
})

test('menu disables PeerHost virtual IDs and rejects invalid payloads', () => {
  const virtualId = createVirtualSessionId('peer-1', 'remote-session-1')
  assert.equal(parseSessionContextMenuTarget(null).kind, 'invalid')
  assert.equal(parseSessionContextMenuTarget({ displayTitle: 'No ID' }).kind, 'invalid')
  assert.equal(parseSessionContextMenuTarget({ sessionId: '../escape' }).kind, 'invalid')
  assert.equal(parseSessionContextMenuTarget({ sessionId: virtualId }).kind, 'virtual')

  let opened = false
  const provider = createSessionDeletionMenuProvider({
    coordinator: {
      getState: () => null,
      isQueued: () => false,
      isDeleting: () => false,
      subscribe: () => () => undefined,
      async refreshActiveList() {},
      async openForSession() { opened = true },
      setConfirmed() {},
      async submitCommit() {},
      async cancelQueued() {},
      async cancelQueuedBySessionId() { return { cancelled: false, unarchived: false } },
      async refreshStatus() {},
      async retryCleanup() {},
      close() {},
      dispose() {},
    },
  })

  const virtualActions = provider.resolve({ sessionId: virtualId, displayTitle: 'Remote Session' })
  assert.equal(virtualActions.length, 1)
  assert.equal(virtualActions[0]!.disabled, true)
  assert.equal(virtualActions[0]!.run, undefined)
  assert.equal(opened, false)
  assert.deepEqual(provider.resolve({ sessionId: '' }), [])
})

test('dialog renders full accessible ID, requires confirmation checkbox, and hides submit buttons when unsupported', () => {
  const longId = 'session-very-long-identifier-1234567890-abcdef'
  const noopCoordinator = {
    getState: () => null,
    isQueued: () => false,
    isDeleting: () => false,
    subscribe: () => () => undefined,
    async refreshActiveList() {},
    async openForSession() {},
    setConfirmed() {},
    async submitCommit() {},
    async cancelQueued() {},
    async cancelQueuedBySessionId() { return { cancelled: false, unarchived: false } },
    async refreshStatus() {},
    async retryCleanup() {},
    close() {},
    dispose() {},
  }

  const unsupportedHtml = renderToStaticMarkup(createElement(SessionDeletionDialog, {
    stage: {
      kind: 'ready',
      sessionId: longId,
      displayTitle: 'Parent Session',
      prepare: {
        sessionId: longId,
        title: 'Parent Session',
        mode: 'unsupported',
        reasonCode: 'SESSION_DELETION_HAS_SUBAGENTS',
        subagentStatus: 'has-children',
        activeReasons: [],
        storageSummary: {
          logDirKnown: true,
          workspaceDetachedNeeded: false,
          projectionCacheEnabled: false,
          spillEnabled: false,
          searchEnabled: false,
        },
      },
      confirmed: false,
      busy: false,
    },
    coordinator: noopCoordinator,
    t,
  }))
  assert.match(unsupportedHtml, new RegExp(longId))
  assert.doesNotMatch(unsupportedHtml, /data-codingns-session-deletion-submit/)

  const immediateHtml = renderToStaticMarkup(createElement(SessionDeletionDialog, {
    stage: {
      kind: 'ready',
      sessionId: longId,
      displayTitle: 'Idle Session',
      prepare: {
        sessionId: longId,
        title: 'Idle Session',
        mode: 'immediate',
        subagentStatus: 'none',
        activeReasons: [],
        operationId: 'op-1',
        storageSummary: {
          logDirKnown: true,
          workspaceDetachedNeeded: false,
          projectionCacheEnabled: false,
          spillEnabled: false,
          searchEnabled: false,
        },
      },
      confirmed: false,
      busy: false,
    },
    coordinator: noopCoordinator,
    t,
  }))
  assert.match(immediateHtml, /data-codingns-session-deletion-submit="immediate"/)
  assert.match(immediateHtml, /disabled=""/)
})

test('main view is only cleared if it still displays the deleted sessionId', async () => {
  let currentMainId = 'session-target'
  let clearCount = 0
  const uiRefresh = createSessionDeletionUiRefreshAdapter(
    { handleSessionRemoved() {} },
    {
      get mainReference() { return { sessionId: currentMainId } },
      clearMain() { clearCount += 1; currentMainId = '' },
    },
  )

  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-target',
              title: 'Target',
              mode: 'immediate',
              subagentStatus: 'none',
              activeReasons: [],
              operationId: 'op-main',
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: false,
                projectionCacheEnabled: false,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        // User navigated to another session while commit was in flight.
        currentMainId = 'session-other'
        return { ok: true, value: { operationId: 'op-main', sessionId: 'session-target', status: 'deleted' } }
      },
    },
    uiRefresh,
  })

  await coordinator.openForSession('session-target', 'Target')
  coordinator.setConfirmed(true)
  await coordinator.submitCommit()
  assert.equal(clearCount, 0)
  assert.equal(currentMainId, 'session-other')

  // When main view STILL displays deleted session, clearMain runs once.
  currentMainId = 'session-target-2'
  const coordinator2 = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-target-2',
              title: 'Target 2',
              mode: 'immediate',
              subagentStatus: 'none',
              activeReasons: [],
              operationId: 'op-main-2',
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: false,
                projectionCacheEnabled: false,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        return { ok: true, value: { operationId: 'op-main-2', sessionId: 'session-target-2', status: 'deleted' } }
      },
    },
    uiRefresh: createSessionDeletionUiRefreshAdapter(
      { handleSessionRemoved() {} },
      {
        get mainReference() { return { sessionId: currentMainId } },
        clearMain() { clearCount += 1; currentMainId = '' },
      },
    ),
  })

  await coordinator2.openForSession('session-target-2', 'Target 2')
  coordinator2.setConfirmed(true)
  await coordinator2.submitCommit()
  assert.equal(clearCount, 1)
  assert.equal(currentMainId, '')
})

test('enableSessionDeletion switch defaults to off and only registers context menu when enabled', () => {
  assert.equal(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.enableSessionDeletion, false)
  const registered: string[] = []
  let settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  const listeners = new Set<() => void>()
  const resources = new FeatureResourceScopeImpl()

  workspaceSessionEnhancementFeature.start({
    descriptor: workspaceSessionEnhancementFeature.descriptor,
    resources,
    services: {
      dshVersion: '0.2.3-alpha.1',
      settings: {
        getSnapshot: () => ({ status: 'ready', value: settings, revision: 1, writable: true }),
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        mutate: async () => true,
      },
      rpc: { call: async () => ({ ok: true, value: [] }) },
      peerHost: {} as never,
      hostRouter: {} as never,
      peerHostSession: {} as never,
      locale: {
        bind: () => t,
        getSnapshot: () => ({ revision: 0, active: 'zh', locales: ['zh', 'en'] } as never),
        subscribe: () => () => undefined,
        register: () => () => undefined,
      },
      contextMenus: {
        register(input) {
          registered.push(input.id)
          return () => {
            const idx = registered.indexOf(input.id)
            if (idx >= 0) registered.splice(idx, 1)
          }
        },
        notify() {},
      },
    },
  })

  assert.equal(registered.includes('codingns.session.delete'), false)
  settings = {
    ...settings,
    workspaceSessionEnhancement: { ...settings.workspaceSessionEnhancement, enableSessionDeletion: true },
  }
  for (const listener of listeners) listener()
  assert.equal(registered.includes('codingns.session.delete'), true)

  void resources.dispose()
  assert.equal(registered.includes('codingns.session.delete'), false)
})

test('queued restart deletion switches row menu to cancel label and supports direct cancellation', async () => {
  let activeQueued = true
  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/list') {
          return {
            ok: true,
            value: activeQueued
              ? [{
                operationId: 'op-queued-1',
                sessionId: 'session-queued-ui',
                status: 'queued',
                mode: 'restart-required',
                cancellable: true,
                retryableCleanup: false,
                pendingCleanupItems: ['workspace'],
                completedCleanupItems: [],
                updatedAt: Date.now(),
              }]
              : [],
          }
        }
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-queued-ui',
              title: 'Queued Session',
              mode: 'restart-required',
              subagentStatus: 'none',
              activeReasons: ['live-session'],
              existingOperation: {
                operationId: 'op-queued-1',
                sessionId: 'session-queued-ui',
                status: 'queued',
                mode: 'restart-required',
                cancellable: true,
                retryableCleanup: false,
                pendingCleanupItems: ['workspace'],
                completedCleanupItems: [],
                updatedAt: Date.now(),
              },
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: true,
                projectionCacheEnabled: false,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        if (endpoint === 'sessionDeletion/cancel') {
          activeQueued = false
          return {
            ok: true,
            value: {
              operationId: 'op-queued-1',
              sessionId: 'session-queued-ui',
              cancelled: true,
              status: 'cancelled',
            },
          }
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`)
      },
    },
  })

  await coordinator.refreshActiveList()
  assert.equal(coordinator.isQueued('session-queued-ui'), true)

  const provider = createSessionDeletionMenuProvider({ coordinator })
  const queuedActions = provider.resolve({ sessionId: 'session-queued-ui', displayTitle: 'Queued Session' })
  assert.equal(queuedActions[0]?.label, t('sessionDeletion.menuLabelCancelQueued'))
  assert.equal(queuedActions[0]?.danger, false)

  await queuedActions[0]!.run?.()
  const statusStage = coordinator.getState()
  assert.equal(statusStage?.kind, 'status')
  const queuedHtml = renderToStaticMarkup(createElement(SessionDeletionDialog, { stage: statusStage!, coordinator, t }))
  assert.match(queuedHtml, /data-codingns-session-deletion-cancel-queued="true"/)

  await coordinator.cancelQueued()
  assert.equal(coordinator.isQueued('session-queued-ui'), false)
  assert.equal(coordinator.getState(), null)

  const afterCancelActions = provider.resolve({ sessionId: 'session-queued-ui', displayTitle: 'Queued Session' })
  assert.equal(afterCancelActions[0]?.label, t('sessionDeletion.menuLabel'))
  assert.equal(afterCancelActions[0]?.danger, true)
})

test('queuing archived restart deletion closes modal immediately, clears main view, notifies archive refresh, and supports cancelQueuedBySessionId', async () => {
  let cleared = 0
  let queueChanges = 0
  let archivedMain = 'session-archive-del'
  const notifications: Array<{ text: string; success: boolean | undefined }> = []
  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-archive-del',
              title: 'Archive Me',
              mode: 'restart-required',
              subagentStatus: 'has-children',
              subagentCount: 2,
              activeReasons: ['live-session'],
              operationId: 'op-arch-1',
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: true,
                projectionCacheEnabled: false,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        if (endpoint === 'sessionDeletion/commit') {
          return {
            ok: true,
            value: {
              operationId: 'op-arch-1',
              sessionId: 'session-archive-del',
              status: 'queued',
              archived: true,
            },
          }
        }
        if (endpoint === 'sessionDeletion/cancel') {
          return {
            ok: true,
            value: {
              operationId: 'op-arch-1',
              sessionId: 'session-archive-del',
              cancelled: true,
              unarchived: true,
              status: 'cancelled',
            },
          }
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`)
      },
    },
    uiRefresh: createSessionDeletionUiRefreshAdapter(
      { handleSessionRemoved() {} },
      {
        get mainReference() { return { sessionId: archivedMain } },
        clearMain() { cleared += 1; archivedMain = '' },
      },
    ),
    onQueueChanged: () => { queueChanges += 1 },
    notify: (text, success) => { notifications.push({ text, success }) },
  })

  await coordinator.openForSession('session-archive-del', 'Archive Me')
  const readyStage = coordinator.getState()
  assert.equal(readyStage?.kind, 'ready')
  const readyHtml = renderToStaticMarkup(createElement(SessionDeletionDialog, { stage: readyStage!, coordinator, t }))
  assert.match(readyHtml, new RegExp(t('sessionDeletion.subagentNotice', { count: '2' }).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

  coordinator.setConfirmed(true)
  await coordinator.submitCommit()

  assert.equal(coordinator.getState(), null, 'must close immediately without showing queued modal')
  assert.equal(cleared, 1)
  assert.equal(queueChanges, 1)
  assert.equal(coordinator.isQueued('session-archive-del'), true)
  assert.equal(notifications[0]?.text, t('sessionDeletion.toastQueuedArchived', { title: 'Archive Me' }))

  const cancelRes = await coordinator.cancelQueuedBySessionId('session-archive-del', 'Archive Me')
  assert.deepEqual(cancelRes, { cancelled: true, unarchived: true })
  assert.equal(queueChanges, 2)
  assert.equal(coordinator.isQueued('session-archive-del'), false)
})

test('immediate submit runs in background, closes modal immediately, disables menu while deleting, and notifies completion', async () => {
  const notifications: Array<{ text: string; success: boolean | undefined }> = []
  let removedId: string | undefined
  let cleared = 0
  let commitPayload: unknown
  let phase: 'deleting' | 'deleted' = 'deleting'

  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint, payload) {
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-bg-del',
              title: 'Background Session',
              mode: 'immediate',
              subagentStatus: 'none',
              activeReasons: [],
              operationId: 'op-bg-del',
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: true,
                projectionCacheEnabled: true,
                spillEnabled: false,
                searchEnabled: true,
              },
            },
          }
        }
        if (endpoint === 'sessionDeletion/commit') {
          commitPayload = payload
          return {
            ok: true,
            value: {
              operationId: 'op-bg-del',
              sessionId: 'session-bg-del',
              status: 'deleting',
            },
          }
        }
        if (endpoint === 'sessionDeletion/status') {
          return {
            ok: true,
            value: {
              operationId: 'op-bg-del',
              sessionId: 'session-bg-del',
              status: phase,
              mode: 'immediate',
              cancellable: false,
              retryableCleanup: false,
              pendingCleanupItems: phase === 'deleting' ? ['search-index'] : [],
              completedCleanupItems: phase === 'deleting' ? [] : ['workspace', 'projection-cache', 'search-index'],
              updatedAt: Date.now(),
            },
          }
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`)
      },
    },
    uiRefresh: createSessionDeletionUiRefreshAdapter(
      { handleSessionRemoved(id: string) { removedId = id } },
      {
        mainReference: { sessionId: 'session-bg-del' },
        clearMain() { cleared += 1 },
      },
    ),
    notify: (text, success) => { notifications.push({ text, success }) },
  })

  await coordinator.openForSession('session-bg-del', 'Background Session')
  coordinator.setConfirmed(true)
  await coordinator.submitCommit()

  assert.deepEqual(commitPayload, { operationId: 'op-bg-del', mode: 'immediate', background: true })
  assert.equal(coordinator.getState(), null, 'dialog closes immediately instead of blocking foreground')
  assert.equal(coordinator.isDeleting('session-bg-del'), true)
  assert.equal(cleared, 1)
  assert.equal(notifications[0]?.text, t('sessionDeletion.toastDeleting', { title: 'Background Session' }))

  const menuWhileDeleting = createSessionDeletionMenuProvider({ coordinator }).resolve({
    sessionId: 'session-bg-del',
    displayTitle: 'Background Session',
  })
  assert.equal(menuWhileDeleting[0]?.label, t('sessionDeletion.menuLabelDeleting'))
  assert.equal(menuWhileDeleting[0]?.disabled, true)

  // Flip background status to deleted and wait for the background poll cycle.
  phase = 'deleted'
  await new Promise((resolve) => setTimeout(resolve, 450))

  assert.equal(coordinator.isDeleting('session-bg-del'), false)
  assert.equal(removedId, 'session-bg-del')
  assert.equal(notifications.at(-1)?.text, t('sessionDeletion.toastDeleted', { title: 'Background Session' }))
  assert.equal(notifications.at(-1)?.success, true)
  coordinator.dispose()
})

test('openForSession avoids status modal when prepare reports background deleting already in progress', async () => {
  const notifications: Array<{ text: string; success: boolean | undefined }> = []
  let phase: 'deleting' | 'deleted' = 'deleting'

  const coordinator = createSessionDeletionCoordinator({
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/prepare') {
          return {
            ok: true,
            value: {
              sessionId: 'session-already-deleting',
              title: 'Already Deleting',
              mode: 'unsupported',
              subagentStatus: 'none',
              activeReasons: [],
              reasonCode: 'SESSION_DELETION_ALREADY_PENDING',
              existingOperation: {
                operationId: 'op-already-del',
                sessionId: 'session-already-deleting',
                status: 'deleting',
                mode: 'immediate',
                cancellable: false,
                retryableCleanup: false,
                pendingCleanupItems: ['workspace'],
                completedCleanupItems: [],
                updatedAt: Date.now(),
              },
              storageSummary: {
                logDirKnown: true,
                workspaceDetachedNeeded: true,
                projectionCacheEnabled: false,
                spillEnabled: false,
                searchEnabled: false,
              },
            },
          }
        }
        if (endpoint === 'sessionDeletion/status') {
          return {
            ok: true,
            value: {
              operationId: 'op-already-del',
              sessionId: 'session-already-deleting',
              status: phase,
              mode: 'immediate',
              cancellable: false,
              retryableCleanup: false,
              pendingCleanupItems: [],
              completedCleanupItems: ['workspace'],
              updatedAt: Date.now(),
            },
          }
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`)
      },
    },
    notify: (text, success) => { notifications.push({ text, success }) },
  })

  await coordinator.openForSession('session-already-deleting', 'Already Deleting')
  assert.equal(coordinator.getState(), null)
  assert.equal(coordinator.isDeleting('session-already-deleting'), true)
  assert.equal(notifications[0]?.text, t('sessionDeletion.toastDeleting', { title: 'Already Deleting' }))

  phase = 'deleted'
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(coordinator.isDeleting('session-already-deleting'), false)
  assert.equal(notifications.at(-1)?.text, t('sessionDeletion.toastDeleted', { title: 'Already Deleting' }))
  coordinator.dispose()
})

test('context menu uses 删除会话 with trash icon and row action registers matching delete button', async () => {
  assert.equal(t('sessionDeletion.menuLabel'), '删除会话')

  const injectedSlots: Array<{ name: string; declaration: Record<string, unknown>; disposed: boolean }> = []
  const menuProviders: Array<unknown> = []
  const handle = startSessionDeletionUi({
    contextMenus: {
      register(provider) {
        menuProviders.push(provider)
        return () => {}
      },
      notify() {},
    },
    rpc: {
      async call(_channel, endpoint) {
        if (endpoint === 'sessionDeletion/list') return { ok: true, value: [] }
        return {
          ok: true,
          value: {
            sessionId: 'session-hover-btn',
            title: 'Hover Session',
            mode: 'immediate',
            subagentStatus: 'none',
            activeReasons: [],
            operationId: 'op-hover-1',
            storageSummary: {
              logDirKnown: true,
              workspaceDetachedNeeded: true,
              projectionCacheEnabled: false,
              spillEnabled: false,
              searchEnabled: false,
            },
          },
        }
      },
    },
    slots: {
      inject(name: string, register: () => () => void) {
        const dispose = register()
        return () => {
          dispose()
        }
      },
      register(declaration: Record<string, unknown>) {
        const entry = { name: String(declaration.name), declaration, disposed: false }
        injectedSlots.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    } as never,
  })

  assert.equal(injectedSlots.length, 2)
  assert.equal(injectedSlots[0]?.name, 'contextMenu.icon')
  assert.equal(injectedSlots[0]?.declaration.key, SESSION_DELETION_MENU_ICON_KEY)
  assert.equal(injectedSlots[1]?.name, 'sidebar.workspaces.session.row.action')
  assert.equal(injectedSlots[1]?.declaration.id, SESSION_DELETION_ROW_ACTION_ID)

  const provider = menuProviders[0] as ReturnType<typeof createSessionDeletionMenuProvider>
  const localActions = provider.resolve({ sessionId: 'session-hover-btn', displayTitle: 'Hover Session' })
  assert.equal(localActions[0]?.label, '删除会话')
  assert.equal(localActions[0]?.icon?.key, SESSION_DELETION_MENU_ICON_KEY)
  assert.equal(localActions[0]?.danger, true)

  const rowButtonHtml = renderToStaticMarkup(createElement(SessionDeleteRowButton, {
    sessionId: 'session-hover-btn',
    displayTitle: 'Hover Session',
    coordinator: handle.coordinator,
  }))
  assert.match(rowButtonHtml, /data-codingns-session-deletion-row-button="session-hover-btn"/)
  assert.match(rowButtonHtml, /aria-label="删除会话"/)
  assert.match(rowButtonHtml, /<svg/)

  const virtualHtml = renderToStaticMarkup(createElement(SessionDeleteRowButton, {
    sessionId: createVirtualSessionId('peer-1', 'session-1'),
    displayTitle: 'Remote Session',
    coordinator: handle.coordinator,
  }))
  assert.equal(virtualHtml, '')

  handle.dispose()
  assert.equal(injectedSlots.every((entry) => entry.disposed), true)
})

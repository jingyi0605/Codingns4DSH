import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { createSessionDeletionFeature } from '../src/host/features/session-deletion.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createTerminalProcessFeature } from '../src/host/features/terminal-process.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'

const fullHostContext = {
  sessionPersistence: {
    root: '/tmp/dsh-sessions',
    stat: async () => undefined,
    list: async () => [],
    open: async () => ({ async close() {} }),
    create: async () => ({ async close() {} }),
    acquireWriteLease: async () => ({ async release() {} }),
  },
  workspaceRegistry: {
    list: () => [],
    unarchiveSession: async () => undefined,
    unpinSession: async () => undefined,
  },
  storageDomain: { get: () => undefined },
  spillStore: { root: '/tmp/dsh-spill' },
  sessionQuery: {
    searchEvents: async () => ({}),
    searchSessions: async () => ({ items: [] }),
  },
}

const fullClientContext = {
  contextMenus: { register: () => () => undefined, notify: () => undefined },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) }, handleSessionRemoved: () => undefined },
  uiWorkspace: { clearMain: () => undefined },
}

test('0.2.2-rc.5 and 0.2.3-alpha.1 resolve session deletion capabilities when services are present and degrade when absent', () => {
  for (const version of ['0.2.2-rc.5', '0.2.3-alpha.1']) {
    const readyHost = createDshCapabilityRegistry(version, 'host', fullHostContext).getProfile(fullHostContext)
    assert.equal(readyHost.capabilities.get('session.deletion.persistence-location')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.immediate')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.restart-replay')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.workspace-cleanup')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.projection-cleanup')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.spill-cleanup')?.status, 'ready', version)
    assert.equal(readyHost.capabilities.get('session.deletion.search-reconcile')?.status, 'ready', version)

    const missingHost = createDshCapabilityRegistry(version, 'host', {}).getProfile({})
    assert.equal(missingHost.capabilities.get('session.deletion.persistence-location')?.status, 'unavailable', version)
    assert.equal(missingHost.capabilities.get('session.deletion.immediate')?.status, 'unavailable', version)

    const readyClient = createDshCapabilityRegistry(version, 'client', fullClientContext).getProfile(fullClientContext)
    assert.equal(readyClient.capabilities.get('ui.context-menu')?.status, 'ready', version)
    assert.equal(readyClient.capabilities.get('session.deletion.ui-refresh')?.status, 'ready', version)

    const missingClient = createDshCapabilityRegistry(version, 'client', {}).getProfile({})
    assert.equal(missingClient.capabilities.get('ui.context-menu')?.status, 'unavailable', version)
    assert.equal(missingClient.capabilities.get('session.deletion.ui-refresh')?.status, 'unavailable', version)
  }
})

test('historical DSH fixtures (0.1.5-rc.3, 0.1.6-alpha.2, 0.1.7-rc.2) mark session deletion capabilities unavailable with diagnostics', () => {
  for (const legacyVersion of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
    const hostProfile = createDshCapabilityRegistry(legacyVersion, 'host', fullHostContext).getProfile(fullHostContext)
    assert.equal(hostProfile.capabilities.get('session.deletion.persistence-location')?.status, 'unavailable', legacyVersion)
    assert.ok(
      hostProfile.diagnostics.some((d) => d.capability === 'session.deletion.persistence-location' && d.code === 'CAPABILITY_VERSION_UNSUPPORTED'),
      legacyVersion,
    )

    const clientProfile = createDshCapabilityRegistry(legacyVersion, 'client', fullClientContext).getProfile(fullClientContext)
    assert.equal(clientProfile.capabilities.get('session.deletion.ui-refresh')?.status, 'unavailable', legacyVersion)
    assert.ok(
      clientProfile.diagnostics.some((d) => d.capability === 'session.deletion.ui-refresh' && d.code === 'CAPABILITY_VERSION_UNSUPPORTED'),
      legacyVersion,
    )
  }
})

test('missing session deletion capability disables only sessionDeletion feature without blocking other Host modules', async () => {
  const profile = createDshCapabilityRegistry('0.2.3-alpha.1', 'host', {}).getProfile({})
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry<CodingNsHostServices>({ rpc, dshContext: {} as never, dshVersion: '0.2.3-alpha.1' }, profile)
  registry.registerMany([
    createSessionDeletionFeature({ replayOnStartup: false }),
    createTerminalProcessFeature(),
  ])
  await registry.reconcile(['sessionDeletion', 'terminalProcess'])
  assert.equal(registry.getSnapshot('sessionDeletion').state, 'disabled')
  assert.equal(registry.getSnapshot('terminalProcess').state, 'enabled')
})

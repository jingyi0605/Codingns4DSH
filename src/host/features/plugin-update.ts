import type { FeatureModule } from '../../shared/contracts/feature.js'
import { updateError } from '../../shared/contracts/plugin-update.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import { isCodingNsOwnerPeer } from '../../dsh-capabilities/host/connection-peer-adapter.js'
import { readUpdateService, type PluginUpdateManager } from '../../dsh-capabilities/host/plugin-update-adapter.js'
import { PluginUpdateMetadata } from '../update/metadata.js'
import { PluginUpdateService, fields } from '../update/service.js'
import type { CodingNsHostServices } from './types.js'

export function createPluginUpdateFeature(options: { readonly request?: typeof fetch } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'pluginUpdate', version: '1.0.0', enabledByDefault: true, dependencies: [], runtime: 'host',
      requires: [{ capability: 'plugin.update.inspect', required: false, fallback: 'degrade' }],
    },
    start(context) {
      const host = context.services.dshContext
      const connection = readUpdateService(host, 'connection')
      const service = new PluginUpdateService(new PluginUpdateMetadata(context.services.dshVersion ?? null, options.request), () => {
        const capability = createDshCapabilityRegistry(context.services.dshVersion ?? '', 'host', host).getProfile(host).capabilities.get('plugin.update.apply')
        return capability?.status === 'ready' ? capability.value as PluginUpdateManager : undefined
      })
      context.resources.add(() => service.dispose())
      const unsubscribe = context.services.events?.on('plugin-manager/install-state', value => service.progress(value))
      if (typeof unsubscribe === 'function') context.resources.add(unsubscribe as () => void)
      context.resources.add(context.services.rpc.register('update', async (action, payload, caller) => {
        const call = fields(caller ?? {})
        const peers = connection as { browserPeer?: unknown; operator?: unknown } | undefined
        if (!peers || (peers.browserPeer === undefined && peers.operator === undefined) || !isCodingNsOwnerPeer(connection, call.peer)) {
          throw updateError('UPDATE_FORBIDDEN')
        }
        if ((action === 'apply' || action === 'cancel') && call.localRequest !== true) throw updateError('UPDATE_LOCAL_OWNER_REQUIRED')
        const signal = call.signal as AbortSignal | undefined
        switch (action) {
          case 'runtime': return service.runtime(call.localRequest === true)
          case 'check': return service.check(payload, call.localRequest === true, signal)
          case 'apply': return service.apply(payload, signal)
          case 'status': return service.status(payload)
          case 'cancel': return service.cancel(payload)
          default: throw updateError('UPDATE_UNKNOWN_ACTION')
        }
      }))
    },
  }
}

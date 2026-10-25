import type { CodingNsClientFeatureModule } from './types.js'

export const pluginUpdateFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'pluginUpdate', version: '1.0.0', enabledByDefault: true, dependencies: [], runtime: 'client',
    requires: [{ capability: 'plugin.client.reload-status', required: false, fallback: 'degrade' }],
  },
  start: () => undefined,
}

import type { CodingNsClientFeatureModule } from './types.js'

export const pluginUpdateFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'pluginUpdate', version: '1.0.0', enabledByDefault: true, dependencies: [], runtime: 'client',
    nativeReplacement: {
      dshFeature: '@deepseek-ai/dsh-plugin-manager third-party updates',
      since: '0.2.2-alpha.2',
      coverage: 'full',
      note: 'The native DSH plugin manager now owns third-party plugin update presentation and recovery.',
    },
    requires: [{ capability: 'plugin.client.reload-status', required: false, fallback: 'degrade' }],
  },
  start: () => undefined,
}

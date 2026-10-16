import { createElement } from 'react'
import type { CodingNsClientFeatureModule } from './types.js'
import { resolveCodingNsTranslator } from '../locale.js'
import { registerQuickAppFooter } from '../../dsh-capabilities/client/quick-app-footer-adapter.js'
import { QuickAppsLauncher } from '../quick-apps/launcher.js'

const t = resolveCodingNsTranslator()
export const quickAppsFeature: CodingNsClientFeatureModule = {
  descriptor: { name: 'quickApps', version: '0.1.0', enabledByDefault: false, dependencies: [], runtime: 'both',
    requires: [{ capability: 'sidebar.footer-action', required: false, fallback: 'disable' }],
    ui: { label: t('quickApps.title'), description: t('quickApps.description'), labelKey: 'quickApps.title', descriptionKey: 'quickApps.description', order: 41, defaultOpen: false } },
  start(context) {
    context.resources.add(registerQuickAppFooter(context.services.slots, props => createElement(QuickAppsLauncher, { services: context.services, wide: props.wide })))
  },
}

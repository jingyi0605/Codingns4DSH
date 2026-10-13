import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from './types.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../../shared/contracts/session-translation.js'

/** 会话翻译服务的生命周期和用户配置由 Host 功能模块统一管理。 */
export function createSessionTranslationFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'sessionTranslation',
      version: '0.1.0',
      enabledByDefault: false,
      dependencies: ['cliAdapters'],
      runtime: 'host',
      requires: [{ capability: 'llm.text', required: false, fallback: 'disable' }],
      ui: {
        label: 'Session translation middleware',
        description: 'Translate selected external Agent requests and visible reasoning or replies while keeping tools, commands, paths, and original history intact.',
        labelKey: 'feature.sessionTranslation.label',
        descriptionKey: 'feature.sessionTranslation.description',
        order: 32,
        defaultOpen: true,
      },
    },
    start(context) {
      const service = context.services.sessionTranslation
      if (service === undefined) return
      const sync = (settings: ReturnType<NonNullable<CodingNsHostServices['settings']>['get']> | undefined): void => {
        service.configure(settings?.sessionTranslation ?? DEFAULT_SESSION_TRANSLATION_SETTINGS)
      }
      sync(context.services.settings?.get())
      service.activate()
      const unwatch = context.services.settings?.watch((next) => sync(next))
      if (unwatch !== undefined) context.resources.add(unwatch)
      context.resources.add(() => service.dispose())
    },
  }
}

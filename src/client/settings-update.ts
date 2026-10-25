import { createElement as h, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientServices } from './features/types.js'
import { useCodingNsTranslator } from './locale.js'
import { CODINGNS_VERSION } from '../shared/contracts/version.js'
import { compareSemver, isSemver } from '../shared/contracts/plugin-update.js'
import { CodingNsSettingsPromo } from './settings-promo.js'
import { settingsPromoClass } from './settings-promo-styles.js'
import { PluginUpdatePanel } from './update-panel.js'
import { DEFAULT_PLUGIN_UPDATE_CHANNEL, PluginUpdateStore, type PluginUpdateSnapshot } from './update-store.js'

export function hasNewerPluginVersion(snapshot: PluginUpdateSnapshot): boolean {
  const target = snapshot.check?.target
  if (!target) return false
  return [CODINGNS_VERSION, snapshot.runtime?.runningHostVersion, snapshot.runtime?.installedVersion]
    .filter((version): version is string => typeof version === 'string' && isSemver(version))
    .every(version => compareSemver(target.version, version) > 0)
}

export function CodingNsSettingsUpdate({ services }: { readonly services: CodingNsClientServices }): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const store = useMemo(() => new PluginUpdateStore(services.rpc), [services.rpc])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const detailsId = useId()
  useEffect(() => {
    void store.loadRuntime()
    void store.recover()
    let checked = false
    const visibility = (): void => {
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
      store.setVisible(visible)
      if (visible && !checked) {
        checked = true
        void store.check({ kind: DEFAULT_PLUGIN_UPDATE_CHANNEL })
      }
    }
    visibility()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
      store.dispose()
    }
  }, [store])
  const versionControl = h('div', { className: settingsPromoClass.versionControl }, h('button', {
    type: 'button', className: settingsPromoClass.version,
    'aria-expanded': open, 'aria-controls': detailsId,
    title: t('update.toggleDetails'),
    onClick: () => { setOpen(!open); setHasOpened(true) },
  }, t('settings.promo.version', { version: CODINGNS_VERSION })),
    h('span', { className: settingsPromoClass.badgeSlot },
      hasNewerPluginVersion(snapshot) ? h('span', {
        className: settingsPromoClass.badge, role: 'status',
        title: t('update.newVersion', { version: snapshot.check!.target!.version }),
        'aria-label': t('update.newVersion', { version: snapshot.check!.target!.version }),
      }, t('update.newVersionBadge')) : null),
  )
  return h(CodingNsSettingsPromo, { locale: services.locale, versionControl },
    h('div', { id: detailsId, hidden: !open, className: settingsPromoClass.details },
      hasOpened ? h(PluginUpdatePanel, { services, enabled: true, store }) : null),
  )
}

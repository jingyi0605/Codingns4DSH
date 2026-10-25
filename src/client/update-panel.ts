import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { FeaturePanelProps } from './features/types.js'
import { useCodingNsTranslator } from './locale.js'
import { dshButtonStyle, dshFieldStyle, dshThemeColor } from './theme.js'
import { CODINGNS_VERSION } from '../shared/contracts/version.js'
import { isSemver, type PluginUpdateChannelKind, type PluginUpdateCheckResult } from '../shared/contracts/plugin-update.js'
import { pluginClientReloadStatus } from '../dsh-capabilities/client/plugin-reload-adapter.js'
import { DEFAULT_PLUGIN_UPDATE_CHANNEL, type PluginUpdateStore } from './update-store.js'
import { installUpdatePanelStyles, updatePanelClass as cls } from './update-panel-styles.js'

const column: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, overflowWrap: 'anywhere' }
const button: CSSProperties = { ...dshButtonStyle, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', alignSelf: 'flex-start' }
const field: CSSProperties = { ...dshFieldStyle, padding: '6px 10px', borderRadius: 6, width: '100%', boxSizing: 'border-box' }

export function PluginUpdatePanel({ services, enabled, store }: Pick<FeaturePanelProps, 'services' | 'enabled'> & { readonly store: PluginUpdateStore }): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const localeTag = t('update.localeTag')
  useEffect(() => installUpdatePanelStyles(), [])
  const [channel, setChannel] = useState<PluginUpdateChannelKind>(DEFAULT_PLUGIN_UPDATE_CHANNEL)
  const [exactVersion, setExactVersion] = useState('')
  const [reviewed, setReviewed] = useState<PluginUpdateCheckResult | null>(null)
  const busy = snapshot.checking || snapshot.starting || snapshot.operation?.state === 'applying'
  const check = snapshot.check
  const blockCode = snapshot.runtime === null ? check?.applyBlockCode : snapshot.runtime.applyBlockCode
  const target = check?.target
  const operation = snapshot.operation
  const result = operation?.result
  const reset = (): void => { store.invalidate(); setReviewed(null) }
  const formattedDate = (value: string | null): string => {
    if (value === null) return t('update.unknown')
    const date = new Date(value)
    return Number.isNaN(date.valueOf()) ? t('update.unknown')
      : new Intl.DateTimeFormat(localeTag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)
  }
  const versionCard = (key: string, value: string | null | undefined): ReactElement =>
    h('div', { key, className: cls.version },
      h('span', { className: cls.versionLabel }, t(key)),
      h('strong', { className: cls.versionValue }, value ?? t('update.unknown')),
    )
  const metadata = (key: string, value: string | null | undefined, code = false): ReactElement =>
    h('div', { key, className: cls.metadataItem },
      h('span', { className: cls.metadataLabel }, t(key)),
      h('span', { className: cls.metadataValue, ...(code ? { style: { fontFamily: dshThemeColor.codeFont } } : {}) }, value ?? t('update.unknown')),
    )
  return h('div', { className: cls.root },
    h('div', { className: cls.versions },
      versionCard('update.hostVersion', snapshot.runtime?.runningHostVersion ?? check?.runningHostVersion),
      versionCard('update.clientVersion', CODINGNS_VERSION),
      versionCard('update.installedVersion', snapshot.runtime?.installedVersion),
    ),
    h('p', { className: cls.note }, t('update.activationHelp')),
    blockCode ? h('p', { className: cls.warning }, t('update.nativeFallback'), ' ', h('code', undefined, blockCode)) : null,
    h('div', { className: cls.controls },
      h('label', { className: cls.fieldLabel }, t('update.channel')),
      h('select', {
        style: field, value: channel, disabled: !enabled || busy,
        onChange: (event: { currentTarget: { value: string } }) => { reset(); setChannel(event.currentTarget.value as PluginUpdateChannelKind) },
      }, h('option', { value: 'latest' }, t('update.latest')), h('option', { value: 'next' }, t('update.next')), h('option', { value: 'exact' }, t('update.exact'))),
    ),
    channel === 'exact' ? h('div', { className: cls.controls }, h('label', { className: cls.fieldLabel }, t('update.exactVersion')), h('input', {
      style: field, value: exactVersion, maxLength: 128, disabled: !enabled || busy,
      onChange: (event: { currentTarget: { value: string } }) => { reset(); setExactVersion(event.currentTarget.value) },
    })) : null,
    h('div', { className: cls.actions }, h('button', {
      type: 'button', style: button, disabled: !enabled || busy || (channel === 'exact' && !isSemver(exactVersion)),
      onClick: () => { setReviewed(null); void store.check(channel === 'exact' ? { kind: 'exact', version: exactVersion } : { kind: channel }) },
    }, t(snapshot.checking ? 'update.checking' : 'update.check'))),
    snapshot.error ? h('div', { role: 'alert', className: cls.warning }, t('update.requestError'), ' ', snapshot.error) : null,
    check ? h('div', { style: column },
      h('div', { role: 'status', className: `${cls.state} ${check.state === 'update-available' ? cls.stateGood : check.state === 'incompatible' || check.state === 'compatibility-unknown' ? cls.stateBad : ''}` }, t(`update.checkState.${check.state}`)),
      !snapshot.current ? h('p', { className: cls.note }, t('update.previousResult')) : null,
      target ? h('div', { className: cls.target },
        h('div', { className: cls.targetHeader },
          h('strong', { className: cls.targetVersion }, `v${target.version}`),
          h('a', { href: target.release.url, target: '_blank', rel: 'noreferrer', style: { ...button, color: dshThemeColor.accent, textDecoration: 'none' } }, t('update.openRelease')),
        ),
        h('div', { className: cls.metadata },
          metadata('update.publishedAt', formattedDate(target.publishedAt)),
          metadata('update.releasePublishedAt', formattedDate(target.release.publishedAt)),
          metadata('update.commit', target.release.commit ?? target.gitHead, true),
          metadata('update.compatibility', `${t(`update.compatibilityState.${target.compatibility.state}`)}${target.compatibility.required ? ` · ${target.compatibility.required}` : ''}`),
        ),
        h('div', { className: cls.notes },
          h('strong', undefined, target.release.title || target.release.tag),
        target.release.state === 'available'
            ? h('pre', { className: cls.notesBody }, target.release.body || t('update.noNotes'))
            : h('p', { className: cls.note }, t('update.noNotes'), ' ', target.release.reason ?? ''),
        ),
      ) : null,
      h('div', { className: cls.actions }, h('button', {
        type: 'button', style: button, disabled: !enabled || busy || !snapshot.current || !check.canApply,
        onClick: () => setReviewed(check),
      }, t('update.review'))),
    ) : null,
    reviewed && reviewed === check && snapshot.current ? h('div', { role: 'group', 'aria-label': t('update.confirmTitle'), className: `${cls.section} ${cls.confirm}` },
      h('strong', undefined, t('update.confirmTitle')),
      h('p', { style: { margin: 0 } }, t('update.confirmHelp', { version: reviewed.target!.version })),
      h('div', { className: cls.actions },
        h('button', { type: 'button', style: button, disabled: busy, onClick: () => { setReviewed(null); void store.apply(reviewed) } }, t('update.confirm')),
        h('button', { type: 'button', style: button, disabled: busy, onClick: () => setReviewed(null) }, t('update.back')),
      ),
    ) : null,
    operation ? h('div', { role: 'status', 'aria-live': 'polite', className: `${cls.section} ${cls.operation}` },
      metadata('update.targetVersion', operation.targetVersion, true),
      h('div', undefined, t(`update.phase.${operation.phase}`)),
      operation.cancellationAvailable ? h('div', { className: cls.actions }, h('button', { type: 'button', style: button, onClick: () => { void store.cancel() } }, t('update.cancel'))) : null,
      result ? h('div', { style: column },
        h('strong', undefined, t(`update.application.${result.application}`)),
        metadata('update.packageState', t(`update.package.${result.packageState}`)),
        metadata('update.hostActivation', `${result.hostActivation.state} · ${result.hostActivation.version ?? t('update.unknown')}`),
        metadata('update.clientActivation', `${result.clientReload.state} · ${pluginClientReloadStatus().version}`),
        h('p', { style: { margin: 0 } }, t('update.nativeFallback')),
        result.errorCode ? h('div', undefined, result.errorCode) : null,
      ) : h('p', { style: { margin: 0 } }, t('update.operationHelp')),
      h('div', { className: cls.actions }, h('button', { type: 'button', style: button, onClick: () => { void store.recover() } }, t('update.refreshStatus'))),
    ) : null,
  )
}

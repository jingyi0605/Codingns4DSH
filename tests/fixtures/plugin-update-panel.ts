import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { CodingNsSettingsUpdate } from '../../src/client/settings-update.js'
import { CodingNsSettingsPromo } from '../../src/client/settings-promo.js'
import { en, zh } from '../../src/client/locales/pluginUpdate.js'

const snapshot = { revision: 0 }
const messages: Record<string, string> = {
  ...en, 'common.brand': 'Codingns4DSH', 'settings.promo.version': 'Version {version}',
  'settings.promo.sectionLabel': 'Codingns4DSH promotion', 'settings.promo.starHint': 'If Codingns4DSH helps you, give it a Star on GitHub.',
  'settings.promo.actionLabel': 'Open Codingns4DSH on GitHub', 'settings.promo.github': 'GitHub',
}
if (new URLSearchParams(location.search).get('lang') === 'zh') {
  Object.assign(messages, zh)
  messages['settings.promo.version'] = '版本 v{version}'
  messages['settings.promo.starHint'] = '如果 Codingns4DSH 帮到了你，请在 GitHub 点个 Star，这对我们意义重大。'
}
const services = {
  locale: {
    bind: () => (key: string, values: Record<string, unknown> = {}) =>
      (messages[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? `{${name}}`)),
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  },
  rpc: {
    async call(_channel: string, endpoint: string, payload: unknown, signal: AbortSignal) {
      const response = await fetch(`/codingns/${endpoint}`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }),
      })
      if (!response.ok) throw new Error(`Fixture HTTP ${response.status}`)
      return (await response.json()).result
    },
  },
}
createRoot(document.querySelector('#root')!).render(h('div', { style: { position: 'relative' } },
  h('style', undefined, '#fixture-original .codingns4dsh-settings-promo-row{flex-direction:row;flex-wrap:nowrap}#fixture-original .codingns4dsh-settings-promo-brand{flex:0 0 auto}@media(max-width:640px){#fixture-original .codingns4dsh-settings-promo-row{flex-direction:column}}'),
  h('div', { id: 'fixture-current' }, h(CodingNsSettingsUpdate, { services: services as never })),
  h('div', { id: 'fixture-original', 'aria-hidden': true, style: { position: 'absolute', top: 0, left: 0, width: '100%', visibility: 'hidden', pointerEvents: 'none' } },
    h(CodingNsSettingsPromo, { locale: services.locale as never })),
))

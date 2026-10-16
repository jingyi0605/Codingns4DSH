import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickAppsLauncher } from '../../src/client/quick-apps/launcher.js'
import { en } from '../../src/client/locales/quickApps.js'

const snapshot = { revision: 0 }
const workspaceSnapshot = { items: [{ workspaceId: 'workspace-a', title: 'Disposable workspace', sessionIds: [] }] }
const services = {
  locale: { bind: () => (key: keyof typeof en, values: Record<string, unknown> = {}) => (en[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? `{${name}}`)), subscribe: () => () => undefined, getSnapshot: () => snapshot },
  uiContext: { get: () => ({ list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => undefined } }) },
  rpc: { call: async (_channel: string, endpoint: string, payload: unknown) => fetch(`/codingns/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }) }).then(response => response.json()).then(envelope => envelope.result) },
}
function SidebarFixture() {
  const [wide, setWide] = useState(true)
  // Match the pinned upstream SidebarRoot's regionArea/footArea/footerActions/settingsArea seats.
  return h('div', { className: 'fixture-layout' }, h('style', null, `
    :root{--dsw-alias-tooltip-bg:#30343b;--dsw-static-neutral-bluish-00:#fff;--dsw-radius-sm:6px}
    .fixture-layout{display:flex;height:100dvh}
    .fixture-sidebar{display:flex;flex-direction:column;box-sizing:border-box;width:260px;padding:6px 12px;border-right:1px solid #8883;background:var(--dsw-alias-bg-layer-1,#f6f7f8)}
    .fixture-sidebar[data-wide=false]{width:56px;padding:18px 10px 6px}
    .fixture-region{flex:1;min-height:0;overflow:hidden}
    .fixture-foot{flex:none;display:flex;flex-direction:column}
    .fixture-footer-actions,.fixture-settings-area{flex:none;min-width:0;width:100%}
    .fixture-footer-actions{display:flex}
    .fixture-sidebar[data-wide=false] .fixture-foot{align-items:center}
    .fixture-sidebar[data-wide=false] :is(.fixture-footer-actions,.fixture-settings-area){display:flex;justify-content:center;width:auto}
    .fixture-settings,.fixture-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
    .fixture-settings:hover,.fixture-toggle:hover{background:#8882}
    .fixture-settings svg{width:18px;height:18px;flex:none}
    .fixture-main{flex:1;min-width:0;display:grid;place-items:center;color:#888;font-size:14px;padding:12px;text-align:center}
  `), h('aside', { className: 'fixture-sidebar', 'data-wide': wide },
    h('button', { className: 'fixture-toggle', 'aria-label': wide ? 'Collapse sidebar' : 'Expand sidebar', onClick: () => setWide(!wide) }, wide ? '☰ Workspace' : '☰'),
    h('div', { className: 'fixture-region' }),
    h('div', { className: 'fixture-foot' },
      h('div', { className: 'fixture-footer-actions' }, h(QuickAppsLauncher, { services: services as never, wide })),
      h('div', { className: 'fixture-settings-area' }, h('button', { className: 'fixture-settings', 'aria-label': 'Settings' },
        h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 8 }), h('circle', { cx: 12, cy: 12, r: 3 })), wide ? 'Settings' : null)))),
    h('main', { className: 'fixture-main' }, 'No active conversation'))
}
createRoot(document.querySelector('#root')!).render(h(SidebarFixture))

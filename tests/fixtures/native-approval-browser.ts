import * as React from '../../node_modules/react/index.js'
import * as jsx from '../../node_modules/react/jsx-runtime.js'
import { createRoot } from '../../node_modules/react-dom/client.js'
import * as primitives from '../../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'
import * as store from '../../node_modules/@deepseek-ai/dsh-client-store/lib/index.js'
import { registerCliConversationSlots } from '../../src/client/cli-slots.js'
import { createPresentationSlots } from '../fixtures/presentation-slots.js'
import { resolveCodingNsTranslator } from '../../src/client/locale.js'
import nativeSource from './native-permission.js?raw'
const h = React.createElement
let native: any
new Function('window', nativeSource)({ __ModuleLoader__: { load({ factory }: any) { native = factory((name: string) => ({ react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': primitives, '@deepseek-ai/dsh-client-store': store })[name]) } } })
const slots = createPresentationSlots()
slots.register({ name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' }, 'conversation.input.right': { kind: 'list', scope: 'session' }, 'conversation.input.permission': { kind: 'single', scope: 'session' } } } as any, () => null)
const original = slots.register({ name: 'conversation.input.permission', locale: 'native', inject: () => ({}) } as any, native.PermissionSelect)
const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) }
let adapter = 'codex', revision = 0, running = true, queued = false
const selections = new Map<string, any>()
const calls: any[] = []
const rpc = { async call(_channel: string, endpoint: string, payload: any) {
  if (endpoint === 'cli/session/set') { selections.set(payload.sessionId, payload); calls.push(payload); return { ok: true, value: payload } }
  if (endpoint === 'cli/session/get') return { ok: true, value: selections.get(payload.sessionId) ?? { adapterId: adapter, nativeApprovalMode: 'inherit' } }
  if (endpoint === 'cli/catalog') return { ok: true, value: [] }
  throw new Error(endpoint)
} }
registerCliConversationSlots(slots as never, rpc, locale as never)
const root = createRoot(document.getElementById('root')!)
const t = (key: string, values: Record<string, any> = {}) => String(native.accessZh[key] ?? key).replace(/\{(\w+)\}/g, (_: string, key: string) => String(values[key] ?? ''))
function render(next: string, active = true, queue = false) {
  running = active; queued = queue
  adapter = next; revision++
  const entry = slots.entries('conversation.input.permission').find(entry => entry.options.id === 'codingns4dsh-native-approval')! as any
  const sessionId = `visual-${adapter}-${revision}`
  root.render(h('main', null, h('p', { className: 'caption' }, adapter === 'dsh' ? 'DSH' : adapter === 'codex' ? 'Codex' : adapter === 'antigravity' ? 'Antigravity' : 'ZCode'), h('div', { className: 'composer', 'data-composer-card': true }, h('div', { className: 'input' }, '输入消息…'), h('div', { className: 'toolbar', 'data-slot': 'conversation.input.permission' }, h(entry.component, {
    ...entry.inject(sessionId), key: sessionId, t, locked: running,
    useSession: (select: any) => select({ sessionId, blank: false, running, queue: queued ? [{}] : [] }),
    useProjection: () => ({ currentValue: 'workspace-write' }),
    usePermissionCatalog: (select: any) => select({ value: { options: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }, { value: 'auto', name: 'auto' }] } }),
    select: async () => true,
  })), h('span', { className: 'agent' }, adapter))))
}
(window as any).fixture = { render, calls, original }
render('codex')

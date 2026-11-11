import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { workspaceMcpFeature } from '../src/client/features/workspace-mcp.ts'
import type { CodingNsClientServices, FeaturePanelProps } from '../src/client/features/types.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: ReactNode): ReactElement<any>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [node, ...Children.toArray(node.props.children).flatMap(elements)]
}

function fixture(options: { readonly initialDestination?: boolean } = {}) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  let created = options.initialDestination === true
  const destination = {
    id: 'destination-1', name: 'Local agent', url: 'http://127.0.0.1:8100/…', enabled: true,
    workspaceIds: null, eventTypes: ['session.completed'], includeLastMessage: true,
  }
  const events = Object.fromEntries(['session.completed', 'session.failed', 'session.permission_requested', 'session.question_asked'].map((type) => [type, { available: true, reason: null }]))
  const services = {
    locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => undefined, getSnapshot: () => ({ revision: 1 }) },
    settings: { async mutate() { return true } },
    rpc: {
      async call(_channel: string, endpoint: string, payload: unknown) {
        calls.push({ endpoint, payload })
        if (endpoint === 'workspaceMcp/status') return { ok: true, value: { apiKeyConfigured: true, enabled: true, listening: true, lanAccessEnabled: false, url: 'http://127.0.0.1:1234/mcp', reason: null } }
        if (endpoint === 'workspaceMcp/webhook-list') return { ok: true, value: {
          destinations: created ? [destination] : [], deliveries: [], workspaces: [{ id: 'workspace-1', name: 'Project' }], events,
        } }
        if (endpoint === 'workspaceMcp/webhook-create') {
          created = true
          return { ok: true, value: { destination, secret: 'one-time-signing-secret' } }
        }
        return { ok: true, value: {} }
      },
    },
  } as unknown as CodingNsClientServices
  const snapshot = { value: DEFAULT_CODINGNS_SETTINGS, status: 'ready' as const, writable: true, revision: 1 }
  const props: FeaturePanelProps = { services, snapshot, enabled: true, notify: () => undefined }
  const renderer = createHookRenderer((value) => workspaceMcpFeature.settingsPanel!(value), props)
  return { calls, renderer }
}

test('Workspace MCP webhook panel lists safe destinations and shows the owner privacy and MCP notices', async (t) => {
  const f = fixture({ initialDestination: true })
  t.after(() => f.renderer.dispose())
  f.renderer.render()
  await setImmediate()
  const html = renderToStaticMarkup(f.renderer.render())
  assert.match(html, /消息通知（Webhook）/u)
  assert.match(html, /Host 会向你配置的地址发送会话摘要/u)
  assert.match(html, /需要开启 MCP 才能执行消息里的下一步/u)
  assert.match(html, /http:\/\/127\.0\.0\.1:8100\/…/u)
})

test('creating a destination displays its signing key once and refreshes the masked list', async (t) => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  f.renderer.render()
  await setImmediate()
  let tree = f.renderer.render()
  const add = elements(tree).find((element) => element.type === 'button' && element.props.children === '添加地址')!
  add.props.onClick()
  tree = f.renderer.render()
  const dialog = elements(tree).find((element) => element.type === 'form' && element.props.role === 'dialog')!
  const inputs = elements(dialog).filter((element) => element.type === 'input')
  const name = inputs.find((element) => element.props.maxLength === 80)!
  name.props.onChange({ currentTarget: { value: 'Local agent' } })
  tree = f.renderer.render()
  const updatedDialog = elements(tree).find((element) => element.type === 'form' && element.props.role === 'dialog')!
  const url = elements(updatedDialog).find((element) => element.type === 'input' && element.props.type === 'url')!
  url.props.onChange({ currentTarget: { value: 'http://127.0.0.1:8100/hook?token=private' } })
  tree = f.renderer.render()
  const form = elements(tree).find((element) => element.type === 'form' && element.props.role === 'dialog')!
  form.props.onSubmit({ preventDefault() {} })
  for (let index = 0; index < 10; index += 1) await setImmediate()
  tree = f.renderer.render()
  const html = renderToStaticMarkup(tree)
  assert.match(html, /one-time-signing-secret/u)
  assert.match(html, /密钥仅在此时显示|请现在复制密钥/u)
  assert.doesNotMatch(html, /token=private/u)
  const create = f.calls.find((call) => call.endpoint === 'workspaceMcp/webhook-create')
  assert.ok(create)
  assert.equal((create.payload as { url: string }).url, 'http://127.0.0.1:8100/hook?token=private')
})

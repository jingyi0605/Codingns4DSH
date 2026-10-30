import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { CodingNsSettingsSection } from '../data/build/dist/client/settings-section.js'
import { SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node)
    ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

function renderSettings(dshVersion: string) {
  const settings = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
  }
  const translate = (key: string, params?: Record<string, unknown>) => {
    const templates: Record<string, string> = {
      'settings.untestedDshWarning': 'DSH {version} is newer than tested DSH {tested}; operation remains enabled.',
    }
    return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), templates[key] ?? key)
  }
  const locale = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ revision: 0 }),
    bind: () => translate,
  }
  const pluginRpc = { call: async () => ({ ok: false, error: { code: 'offline', message: 'offline' } }) }
  const services = { dshVersion, settings, locale, rpc: pluginRpc }
  const section = createHookRenderer(CodingNsSettingsSection, {
    settings, registry: { modules: () => [] }, services,
  } as never)
  return { section, elements: () => elements(section.render()) }
}

test('settings displays an advisory for newer DSH versions and records the tested version', () => {
  const view = renderSettings('0.3.0-alpha.1')
  try {
    const warning = view.elements().find(element => element.type === 'div' && element.props.role === 'status' && typeof element.props.children === 'string' && element.props.children.includes('0.3.0-alpha.1'))
    assert.ok(warning, JSON.stringify(view.elements().map(element => ({ type: element.type, role: element.props.role, children: element.props.children }))))
    assert.match(String(warning.props.children), new RegExp(SUPPORTED_DSH_VERSION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    const testedVersion = view.elements().find(element => element.type === 'div' && element.props.children === 'settings.testedDshVersion')
    assert.ok(testedVersion)
  } finally { view.section.dispose() }
})

test('settings does not show an unverified-version warning at the tested DSH version', () => {
  const view = renderSettings(SUPPORTED_DSH_VERSION)
  try {
    assert.equal(view.elements().some(element => element.type === 'div' && element.props.role === 'status' && typeof element.props.children === 'string' && element.props.children.includes('newer than tested DSH')), false)
  } finally { view.section.dispose() }
})

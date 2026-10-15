import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { sessionTranslationFeature } from '../src/client/features/session-translation.js'
import { SessionTranslationRules } from '../src/client/session-translation-rules.js'
import { DshButton, DshModal } from '../src/dsh-capabilities/client/primitives-adapter.js'
import type { CodingNsClientServices, FeaturePanelProps } from '../src/client/features/types.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS, type SessionTranslationSettings } from '../src/shared/contracts/session-translation.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const tr = resolveCodingNsTranslator()
const model = { provider: 'test', model: 'primary' }

function elements(node: ReactNode): ReactElement<any>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  if (node.type === DshModal && !(node.props as any).open) return [node]
  return [node, ...Children.toArray(node.props.children).flatMap(elements), ...elements((node.props as any).footer)]
}

function renderRules(props: FeaturePanelProps): ReactElement {
  const panel = sessionTranslationFeature.settingsPanel!(props)
  const field = elements(panel).find(element => element.type === SessionTranslationRules)!
  assert.ok(field)
  return (field.type as (props: any) => ReactElement)(field.props)
}

function fixture(rules: string[] = []) {
  const writes: { field: string; value: SessionTranslationSettings }[] = []
  const snapshot = {
    value: { ...DEFAULT_CODINGNS_SETTINGS, sessionTranslation: {
      ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: true, bilingual: true,
      translationModels: [model], translationRules: rules,
    } },
    status: 'ready' as const, writable: true, revision: 1,
  }
  const services = {
    settings: { async set(field: string, value: SessionTranslationSettings) {
      writes.push({ field, value })
      snapshot.value = { ...snapshot.value, sessionTranslation: value } as typeof snapshot.value
      return true
    } },
    rpc: { async call() { return { ok: true, value: { models: [], default: null, errors: [] } } } },
    locale: { bind: () => tr, subscribe: () => () => undefined, getSnapshot: () => ({ revision: 1 }) },
  } as unknown as CodingNsClientServices
  const props: FeaturePanelProps = { services, snapshot, enabled: true, notify: () => undefined }
  const renderer = createHookRenderer(renderRules, props)
  return { writes, snapshot, props, renderer }
}

function button(tree: ReactElement, key: string, number?: number): ReactElement<any> {
  const label = tr(key, number === undefined ? {} : { number })
  const result = elements(tree).find(element => element.type === DshButton && element.props.children === label)
  assert.ok(result, `Missing button: ${key}`)
  return result
}

function modal(tree: ReactElement): ReactElement<any> { return elements(tree).find(element => element.type === DshModal)! }
function textarea(tree: ReactElement): ReactElement<any> { return elements(tree).find(element => element.type === 'textarea')! }
function input(f: ReturnType<typeof fixture>, text: string): ReactElement {
  textarea(f.renderer.render()).props.onChange({ currentTarget: { value: text } })
  return f.renderer.render()
}

test('rules can be added, edited, and removed without changing language or model settings', async t => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  for (const rule of ['Keep product names.', 'Use a formal tone.\nKeep sentences concise.']) {
    button(f.renderer.render(), 'translation.ruleAdd').props.onClick()
    assert.equal(button(f.renderer.render(), 'translation.ruleSave').props.disabled, true)
    assert.equal(button(input(f, ' \n '), 'translation.ruleSave').props.disabled, true)
    button(input(f, `  ${rule}  `), 'translation.ruleSave').props.onClick()
    await setImmediate()
    assert.equal(modal(f.renderer.render()).props.open, false)
  }
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, ['Keep product names.', 'Use a formal tone.\nKeep sentences concise.'])
  button(f.renderer.render(), 'translation.ruleEdit', 1).props.onClick()
  assert.equal(textarea(f.renderer.render()).props.value, 'Keep product names.')
  button(input(f, 'Keep company names.'), 'translation.ruleSave').props.onClick()
  await setImmediate()
  button(f.renderer.render(), 'translation.ruleRemove', 2).props.onClick()
  await setImmediate()
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, ['Keep company names.'])
  button(f.renderer.render(), 'translation.ruleRemove', 1).props.onClick()
  await setImmediate()
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, [])
  for (const write of f.writes) {
    assert.equal(write.field, 'sessionTranslation')
    assert.equal(write.value.nativeEnabled, true)
    assert.equal(write.value.bilingual, true)
    assert.equal(write.value.inputLanguage, 'en')
    assert.equal(write.value.outputLanguage, 'zh')
    assert.deepEqual(write.value.translationModels, [model])
  }
})

test('cancellation and unchanged edits do not write settings', t => {
  const f = fixture(['Original rule'])
  t.after(() => f.renderer.dispose())
  button(f.renderer.render(), 'translation.ruleEdit', 1).props.onClick()
  button(input(f, 'Uncommitted edit'), 'translation.ruleCancel').props.onClick()
  assert.equal(modal(f.renderer.render()).props.open, false)
  button(f.renderer.render(), 'translation.ruleAdd').props.onClick()
  modal(input(f, 'Uncommitted addition')).props.onClose()
  button(f.renderer.render(), 'translation.ruleEdit', 1).props.onClick()
  button(f.renderer.render(), 'translation.ruleSave').props.onClick()
  assert.equal(modal(f.renderer.render()).props.open, false)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, ['Original rule'])
})

test('pending saves lock the editor and rejected saves preserve drafts for retry', async t => {
  const f = fixture(['Original rule'])
  t.after(() => f.renderer.dispose())
  const originalSet = f.props.services.settings.set
  let rejectWrite: (error: Error) => void = () => undefined
  f.props.services.settings.set = () => new Promise((_resolve, reject) => { rejectWrite = reject })
  button(f.renderer.render(), 'translation.ruleEdit', 1).props.onClick()
  button(input(f, 'Edited rule'), 'translation.ruleSave').props.onClick()
  const pending = f.renderer.render()
  assert.ok(elements(pending).filter(element => element.type === DshButton || element.type === 'textarea').every(element => element.props.disabled))
  assert.equal(button(pending, 'translation.ruleSaving').props.disabled, true)
  modal(pending).props.onClose()
  assert.equal(modal(f.renderer.render()).props.open, true)
  rejectWrite(new Error('settings write rejected'))
  await setImmediate()
  const failed = f.renderer.render()
  assert.equal(modal(failed).props.open, true)
  assert.equal(textarea(failed).props.value, 'Edited rule')
  assert.ok(elements(failed).some(element => element.props.role === 'alert'))
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, ['Original rule'])
  f.props.services.settings.set = originalSet
  button(failed, 'translation.ruleSave').props.onClick()
  await setImmediate()
  assert.equal(modal(f.renderer.render()).props.open, false)
  assert.deepEqual(f.snapshot.value.sessionTranslation.translationRules, ['Edited rule'])
})

test('disabled, loading, and read-only settings prevent rule changes', t => {
  const f = fixture(['Original rule'])
  t.after(() => f.renderer.dispose())
  for (const props of [
    { ...f.props, enabled: false },
    { ...f.props, snapshot: { ...f.snapshot, writable: false } },
    { ...f.props, snapshot: { ...f.snapshot, status: 'loading' as const } },
  ]) {
    const tree = f.renderer.render(props)
    assert.ok(elements(tree).filter(element => element.type === DshButton).every(element => element.props.disabled))
    button(tree, 'translation.ruleAdd').props.onClick()
    button(tree, 'translation.ruleEdit', 1).props.onClick()
    button(tree, 'translation.ruleRemove', 1).props.onClick()
    assert.equal(modal(f.renderer.render()).props.open, false)
  }
  assert.equal(f.writes.length, 0)
})

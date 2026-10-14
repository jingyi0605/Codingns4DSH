import type { InteractionTranslationField, InteractionTranslationResult } from '../../shared/contracts/interaction-translation.js'
import { TRANSLATION_GLYPH_PATHS, TRANSLATION_GLYPH_SIZE, TRANSLATION_PENDING_BADGE_STYLE, TRANSLATION_STATUS_BADGE_STYLE } from '../../shared/translation-indicator.js'

export type NativeInteractionTextKind = 'question' | 'todo'
type TranslationStatus = 'pending' | 'complete' | 'failed'

// Scoped to the inspected alpha.1/alpha.2 native fields, never controls or editable drafts.
const SELECTORS: Record<NativeInteractionTextKind, string> = {
  question: [
    '[data-question-key] h2', '[data-question-key] [class$="_eyebrow"]',
    '[data-question-key] [class$="_optionLabel"]', '[data-question-key] [class$="_description"]',
    '[data-question-key] [class$="_detail"]',
    '[data-plan-review-key] h3', '[data-plan-review-key] [class$="_description"]',
  ].join(','),
  todo: '[data-testid="todo-panel"] [class$="_content"]',
}
const MARKER = 'data-codingns-translation-marker'
const EXCLUDED = `code,pre,textarea,input,svg,[contenteditable="true"],[${MARKER}]`

interface TextTarget {
  readonly key: string
  readonly node: Text
  original: string
  displayed: string
  option?: Element
  originalLabel?: string
}

/** Keep React's text nodes in place; only their visible value and an owned marker change. */
export function watchNativeInteractionText(
  root: HTMLElement, kind: NativeInteractionTextKind,
  onFields: (fields: readonly InteractionTranslationField[]) => void,
) {
  const doc = root.ownerDocument
  const targets = new Map<Text, TextTarget>()
  const markers = new Map<Element, { element: HTMLElement; original: string; status: TranslationStatus }>()
  let nextKey = 0
  let result: InteractionTranslationResult | undefined
  let signature = ''
  let disposed = false
  const restore = (target: TextTarget): void => {
    if (target.node.nodeValue === target.displayed) target.node.nodeValue = target.original
    if (target.option?.getAttribute('aria-label') === target.displayed && target.originalLabel !== undefined) {
      target.option.setAttribute('aria-label', target.originalLabel)
    }
    target.displayed = target.original
  }
  const apply = (target: TextTarget): void => {
    const record = result?.enabled ? result.records[target.key] : undefined
    if (record === undefined || record.failed || record.original !== target.original || record.translated === target.original || record.translated.trim() === '') {
      restore(target)
      return
    }
    target.displayed = record.translated
    target.node.nodeValue = target.displayed
    if (target.option !== undefined) target.option.setAttribute('aria-label', target.displayed)
  }
  const observe = (): void => observer?.observe(root, { childList: true, subtree: true, characterData: true })
  const scan = (): void => {
    if (disposed) return
    observer?.disconnect()
    const nodes = new Set<Text>()
    const visit = (node: Node): void => {
      if (node.nodeType === 3) {
        if (node.nodeValue?.trim()) nodes.add(node as Text)
      } else if (node.nodeType === 1 && !(node as Element).matches(EXCLUDED)) {
        for (const child of node.childNodes) visit(child)
      }
    }
    for (const field of root.querySelectorAll(SELECTORS[kind])) visit(field)
    for (const [node, target] of targets) {
      if (!nodes.has(node)) { restore(target); targets.delete(node) }
    }
    const groups = new Map<Element, TextTarget[]>()
    for (const node of nodes) {
      let target = targets.get(node)
      if (target !== undefined && node.nodeValue !== target.displayed) {
        restore(target)
        targets.delete(node)
        target = undefined
      }
      if (target === undefined) {
        const original = node.nodeValue ?? ''
        target = { key: `text.${nextKey++}`, node, original, displayed: original }
        const parent = node.parentElement
        const option = parent?.matches('[class$="_optionLabel"]') ? parent.closest('[role="radio"],[role="checkbox"]') : null
        const label = option?.getAttribute('aria-label')
        if (option && label !== null && label !== undefined) { target.option = option; target.originalLabel = label }
        targets.set(node, target)
      }
      const parent = node.parentElement
      const group = parent?.closest('[role="radio"],[role="checkbox"]')
        ?? parent?.closest('[data-question-key],[data-plan-review-key],[data-status]') ?? parent
      if (group !== null && group !== undefined) {
        const members = groups.get(group) ?? []
        members.push(target)
        groups.set(group, members)
      }
    }
    const fields = [...targets.values()].map(target => ({ key: target.key, text: target.original }))
    const next = JSON.stringify(fields)
    const changed = signature !== next
    // Newly mounted pages or changed native text need their own pending indicators.
    if (changed && result?.enabled !== false) result = undefined
    for (const target of targets.values()) apply(target)
    for (const [group, marker] of markers) {
      if (!groups.has(group) || result?.enabled === false) {
        marker.element.remove()
        markers.delete(group)
      }
    }
    for (const [group, members] of groups) {
      if (result?.enabled === false) continue
      const original = members.map(target => target.original).join('\n')
      const status: TranslationStatus = result === undefined ? 'pending' : members.some(target => {
        const record = result?.records[target.key]
        return record === undefined || record.failed || record.original !== target.original || record.translated.trim() === ''
      }) ? 'failed' : 'complete'
      let marker = markers.get(group)
      if (marker === undefined || marker.original !== original || marker.status !== status) {
        marker?.element.remove()
        marker = { element: createTranslationMarker(doc, original, status), original, status }
        markers.set(group, marker)
      }
      // Grouping changes only the indicator: each field is still translated independently.
      const last = members[members.length - 1]!.node
      if (last.nextSibling !== marker.element) last.parentNode?.insertBefore(marker.element, last.nextSibling)
    }
    if (changed) { signature = next; onFields(fields) }
    observe()
  }
  const Observer = doc.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(scan)
  scan()
  return {
    update(next: InteractionTranslationResult | undefined) { result = next; scan() },
    dispose() {
      disposed = true
      observer?.disconnect()
      for (const target of targets.values()) restore(target)
      for (const marker of markers.values()) marker.element.remove()
      markers.clear()
      targets.clear()
    },
  }
}

/** Hover reveals the source; the marker cannot focus, select, or submit its parent option. */
export function createTranslationMarker(doc: Document, original: string, status: TranslationStatus = 'complete'): HTMLElement {
  const marker = doc.createElement('span')
  marker.setAttribute(MARKER, '')
  marker.title = original
  marker.setAttribute('aria-label', original)
  marker.style.cssText = 'position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;vertical-align:middle;margin-inline-start:2px;color:var(--dsw-alias-label-tertiary, GrayText);cursor:help;user-select:none;line-height:1'
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: String(TRANSLATION_GLYPH_SIZE), height: String(TRANSLATION_GLYPH_SIZE), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) icon.setAttribute(key, value)
  for (const d of TRANSLATION_GLYPH_PATHS) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    icon.append(path)
  }
  marker.append(icon)
  const badge = doc.createElement('span')
  badge.setAttribute('aria-hidden', 'true')
  if (status === 'pending') badge.setAttribute('data-codingns-translation-pending', '')
  Object.assign(badge.style, TRANSLATION_STATUS_BADGE_STYLE, {
    background: status === 'failed' ? 'var(--dsw-alias-state-error-primary, #b42318)' : 'var(--dsw-alias-state-success-primary, #16803c)',
  }, status === 'pending' ? TRANSLATION_PENDING_BADGE_STYLE : {})
  badge.textContent = status === 'pending' ? '' : status === 'failed' ? '!' : '✓'
  marker.append(badge)
  const stop = (event: Event): void => { event.preventDefault(); event.stopPropagation() }
  for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick']) marker.addEventListener(name, stop)
  return marker
}

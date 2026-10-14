export interface PendingTranslationTarget {
  readonly key: number
  readonly container: HTMLElement
  readonly original: string
}

/** Pending DSH bubbles have no renderer slot; attach only to their action rows. */
export function watchPendingTranslationTargets(
  anchor: HTMLElement,
  onChange: (targets: readonly PendingTranslationTarget[]) => void,
): () => void {
  const root = anchor.closest<HTMLElement>('[data-conversation-session]')
  const Observer = anchor.ownerDocument.defaultView?.MutationObserver
  if (root === null || Observer === undefined) return () => undefined
  const targets = new Map<HTMLElement, PendingTranslationTarget>()
  let nextKey = 0
  const scan = (): void => {
    observer.disconnect()
    let changed = false
    const rows = new Set(root.querySelectorAll<HTMLElement>('[data-submission-echo]'))
    for (const [row, target] of targets) {
      if (rows.has(row) && root.contains(target.container)) continue
      target.container.remove()
      targets.delete(row)
      changed = true
    }
    for (const row of rows) {
      if (row.closest('[data-conversation-session]') !== root) continue
      const original = row.querySelector<HTMLElement>('[class*="bubble"]')?.textContent ?? ''
      const actions = row.querySelector<HTMLElement>('[data-clock="start"]')
      if (original.trim() === '' || actions === null) continue
      const existing = targets.get(row)
      if (existing !== undefined) {
        if (existing.original !== original) {
          targets.set(row, { ...existing, original })
          changed = true
        }
        continue
      }
      const container = anchor.ownerDocument.createElement('span')
      container.dataset.codingnsPendingTranslation = ''
      container.style.display = 'inline-flex'
      let before: HTMLElement | null = actions.querySelector('button')
      while (before !== null && before.parentElement !== actions) before = before.parentElement
      actions.insertBefore(container, before)
      targets.set(row, { key: nextKey++, container, original })
      changed = true
    }
    if (changed) onChange([...targets.values()])
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }
  const observer = new Observer(scan)
  scan()
  return () => {
    observer.disconnect()
    for (const target of targets.values()) target.container.remove()
    targets.clear()
  }
}

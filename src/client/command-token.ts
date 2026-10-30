export interface InputTokenSelection {
  readonly start: number
  readonly end: number
  readonly draftRev?: number
}

export interface InputTokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** Returns the standalone slash opened by the operation menu when it is still in the draft. */
export function bareSlashSpanAtCaret(
  draft: string,
  draftRev: number,
  selection?: InputTokenSelection,
): InputTokenSpan | undefined {
  if (selection !== undefined && selection.start !== selection.end) return undefined
  const caret = selection?.end ?? draft.length
  if (caret <= 0 || draft.charAt(caret - 1) !== '/') return undefined
  const slash = caret - 1
  const previous = draft.charAt(slash - 1)
  if (slash > 0 && !/\s/u.test(previous)) return undefined
  return { start: slash, end: caret, draftRev }
}

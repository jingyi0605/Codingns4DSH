/** Keep DOM consumers aligned with the context presentation's owned child slots. */
export function contextComposerSlotName(name: string): string {
  return `codingns.grok-context.${name}`
}

export function composerSlotSelector(name: string): string {
  return `:is([data-slot="${name}"],[data-slot="${contextComposerSlotName(name)}"])`
}

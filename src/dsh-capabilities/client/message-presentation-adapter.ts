import type { ReactNode } from 'react'

type ProjectText = (text: string, labels: readonly string[], skills: readonly string[], skillLabel: string, actions?: { openFile: (...args: any[]) => unknown; openSkill: (...args: any[]) => unknown }) => ReactNode
export interface MessagePresentation {
  readonly kind: 'legacy' | 'factory'
  mount(register: () => () => void): () => void
  projectText: ProjectText
  userContent(owner: any, content: Record<string, unknown>, facts: Record<string, unknown>): ReactNode
  images(owner: any, props: Record<string, unknown>): ReactNode
}

interface PresentationSlots {
  inject?(key: string, register: () => () => void): () => void
  register?: unknown
  registerFactory?: unknown
}

function slotsOf(context: unknown): PresentationSlots | undefined {
  return (context as { slots?: PresentationSlots })?.slots
}

export function supportsLegacyMessagePresentation(context: unknown, exports?: unknown): boolean {
  const slots = slotsOf(context)
  return typeof slots?.inject === 'function' && typeof slots.register === 'function'
    && typeof (exports as { projectUserText?: unknown })?.projectUserText === 'function'
}

export function supportsFactoryMessagePresentation(context: unknown): boolean {
  const slots = slotsOf(context)
  return typeof slots?.inject === 'function' && typeof slots.register === 'function'
    && typeof slots.registerFactory === 'function'
}

export function createLegacyMessagePresentation(exports: unknown): MessagePresentation {
  return {
    kind: 'legacy',
    mount: register => register(),
    projectText: (exports as { projectUserText: ProjectText }).projectUserText,
    userContent: () => null,
    images: (owner, props) => owner.renderMessageImages(props),
  }
}

/** Native factories preserve the host's text transforms, reference actions and image authorization. */
export function createFactoryMessagePresentation(context: unknown): MessagePresentation {
  const slots = slotsOf(context)!
  return {
    kind: 'factory',
    // These public child declarations share the native factories' lifetime.
    // SlotRegistry exposes no factory subscription; the image outlet itself
    // reacts to image-factory registration, so it need not delay text rendering.
    mount: register => slots.inject!('conversation.user.text.node', () =>
      slots.inject!('conversation.chat.user.images', register)),
    projectText: () => null,
    userContent: (owner, content, facts) => owner.renderFactorySlot('conversation.chat.user.content', {
      content, facts, loadImage: owner.loadImage, interactive: true,
    }),
    images: (owner, props) => owner.renderFactorySlot('conversation.images.content', { ...props, loadImage: owner.loadImage }),
  }
}

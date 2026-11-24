import { commonmarkLanguage } from '@codemirror/lang-markdown'
import { createElement } from 'react'
import { followPresentationEntry, mirrorPresentationSlot, type PresentationSlots } from '../dsh-capabilities/client/slot-presentation-mirror.js'

const assistantSlot = 'conversation.chat.node'

/** Convert local file URLs into the path syntax consumed by DSH's Markdown renderer. */
export function normalizeMarkdownFileLinks(text: string): string {
  if (!/file:\/\/\//iu.test(text)) return text
  let result = ''
  let previousEnd = 0
  commonmarkLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.name !== 'URL') return
      const parent = node.node.parent?.name
      if (parent !== 'Link' && parent !== 'LinkReference') return
      const destination = text.slice(node.from, node.to)
      const match = /^(<?)file:\/\/(\/(?!\/).+)$/iu.exec(destination)
      if (match === null) return
      const [, opening, path] = match
      result += text.slice(previousEnd, node.from) + opening + path!.replace(/^\/(?=[a-z]:\/)/iu, '')
      previousEnd = node.to
    },
  })
  return previousEnd === 0 ? text : result + text.slice(previousEnd)
}

export function installMarkdownFileLinks(slots: Partial<PresentationSlots>): (() => void) | undefined {
  if (typeof slots.inject !== 'function' || typeof slots.register !== 'function'
    || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return undefined
  const registry = slots as PresentationSlots
  return followPresentationEntry(registry, assistantSlot,
    entry => entry.options.key === 'assistant-step' && (entry.options.priority ?? 0) >= 0,
    entry => {
      const childNames = new Map(Object.keys(entry.children ?? {})
        .map(name => [name, `codingns.markdown-file-links.${name}`]))
      const children = Object.fromEntries(Object.entries(entry.children ?? {})
        .map(([name, spec]) => [childNames.get(name)!, spec]))
      const remove = registry.register({
        name: assistantSlot,
        ...entry.options,
        priority: (entry.options.priority ?? 0) - 1,
        ...(entry.locale === undefined ? {} : { locale: entry.locale }),
        ...(entry.inject === undefined ? {} : { inject: entry.inject }),
        ...(entry.store === undefined ? {} : { store: entry.store }),
        ...(entry.select === undefined ? {} : { select: entry.select }),
        children,
      }, props => {
        const data = props.node.data
        let changed = false
        const blocks = data.status === 'running' ? data.blocks : data.blocks.map((block: { kind: string; text?: string }) => {
          if (block.kind !== 'text' || block.text === undefined) return block
          const text = normalizeMarkdownFileLinks(block.text)
          if (text === block.text) return block
          changed = true
          return { ...block, text }
        })
        return createElement(entry.component, {
          ...props,
          node: changed ? { ...props.node, data: { ...data, blocks } } : props.node,
          renderSlot: (name: string, ...args: unknown[]) => props.renderSlot(childNames.get(name) ?? name, ...args),
        })
      })
      const removeChildren: (() => void)[] = []
      try {
        for (const [name, alias] of childNames) {
          removeChildren.push(mirrorPresentationSlot(registry, name, alias, createElement))
        }
      } catch (error) {
        for (const dispose of removeChildren.reverse()) dispose()
        remove()
        throw error
      }
      return () => {
        for (const dispose of removeChildren.reverse()) dispose()
        remove()
      }
    },
  )
}

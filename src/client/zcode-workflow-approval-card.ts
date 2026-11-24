import { createElement as h, lazy, Suspense, useMemo, type ComponentType } from 'react'
import { MarkdownDelegateProvider, useMarkdownDelegate } from '@deepseek-ai/dsh-client-ui-primitives'
import { isTranslationQuestionCard } from '../dsh-capabilities/client/interaction-presentation-adapter.js'
import { followPresentationEntry, type PresentationSlots } from '../dsh-capabilities/client/slot-presentation-mirror.js'
import type { TranslationQuestionCard } from '../shared/contracts/interaction-presentation.js'
import { ZCODE_WORKFLOW_APPROVAL_QUESTION_ID } from '../shared/contracts/zcode-workflow.js'

import { useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'

type WorkflowDiagramProps = { original: string; t: CodingNsTranslator }

const WorkflowDiagram = lazy<ComponentType<WorkflowDiagramProps>>(async () => {
  try {
    const [{ default: Diagram }, { workflowScriptParser }] = await Promise.all([
      import('./zcode-workflow-approval-diagram.js'),
      import('./editor-engine.js'),
    ])
    return { default: ({ original, t }) => h(Diagram, { original, t, parser: workflowScriptParser }) }
  } catch {
    return { default: ({ t }) => h('span', null, t('workflow.approvalPreview.error')) }
  }
})
const previewFence = 'codingns-workflow-approval'

/** Keep the native composer, focus handling and answer controls; only replace its detail. */
export function registerZcodeWorkflowApprovalPresentation(value: unknown, locale: CodingNsLocale): () => void {
  const slots = value as Partial<PresentationSlots> | undefined
  if (typeof MarkdownDelegateProvider !== 'function' || typeof useMarkdownDelegate !== 'function'
    || slots == null || typeof slots.inject !== 'function' || typeof slots.register !== 'function'
    || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return () => undefined
  return followPresentationEntry(slots as PresentationSlots, 'conversation.composer',
    entry => entry.children?.['conversation.plan-review.actions'] !== undefined && typeof entry.select === 'function',
    native => {
      const select = native.select as (owner: unknown) => unknown
      return slots.register!({
        name: 'conversation.composer', priority: -200,
        locale: native.locale, inject: native.inject, store: native.store,
        select: (owner: unknown) => {
          const card = select(owner)
          if (!isTranslationQuestionCard(card) || card.kind !== 'question' || card.questions.length !== 1) return null
          const [question] = card.questions
          return question?.id === ZCODE_WORKFLOW_APPROVAL_QUESTION_ID && typeof question.detail === 'string' ? card : null
        },
      }, props => h(WorkflowApprovalComposer, { native: native.component, props, locale }))
    })
}

function WorkflowApprovalComposer({ native, props, locale }: {
  native: ComponentType<any>
  props: { matched: TranslationQuestionCard }
  locale: CodingNsLocale
}) {
  const t = useCodingNsTranslator(locale)
  const card = props.matched
  const original = card.questions[0]?.detail ?? ''
  const display = useMemo(() => {
    const questions = card.questions.map(question => ({
      ...question, detail: '```' + previewFence + '\npreview\n```',
    }))
    // Native PendingQuestion methods access private fields on the original instance.
    const methods = new Map<PropertyKey, unknown>()
    return new Proxy(card, {
      get(target, key) {
        if (key === 'questions') return questions
        const value: unknown = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        if (!methods.has(key)) methods.set(key, value.bind(target))
        return methods.get(key)
      },
    })
  }, [card])
  const inherited = useMarkdownDelegate()
  return h(MarkdownDelegateProvider, {
    ...inherited,
    renderCode: fence => fence.lang === previewFence
      ? h('div', { 'data-codingns-workflow-approval-diagram': '', style: { display: 'grid', gap: 6, minWidth: 0 } },
        h(Suspense, { fallback: t('workflow.approvalPreview.loading') }, h(WorkflowDiagram, { original, t })),
        h('details', null,
          h('summary', { style: { cursor: 'pointer', fontSize: '0.9em' } }, t('workflow.approvalPreview.original')),
          h('pre', { tabIndex: 0, style: {
            maxHeight: 'min(180px, 24vh)', overflow: 'auto', overscrollBehavior: 'contain',
            margin: '6px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          } }, original)))
      : inherited.renderCode?.(fence) ?? h('pre', null, fence.code),
    children: h(native, { ...props, matched: display }),
  })
}

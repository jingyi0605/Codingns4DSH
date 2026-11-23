import type { CodingNsTranslator } from './locale.js'
import { createElement as h, Fragment, useMemo, type CSSProperties, type ReactElement } from 'react'
import { dshThemeColor } from './theme.js'
import { readWorkflowApprovalPreview, type WorkflowPreviewNode, type WorkflowScriptParser } from './zcode-workflow-approval-preview.js'

const box: CSSProperties = {
  minWidth: 0, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8,
  padding: '5px 9px', overflowWrap: 'anywhere',
}
const scrolling: CSSProperties = { overflow: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin' }
const diagramSize: CSSProperties = { ...scrolling, maxHeight: 'min(148px, 19vh)', scrollbarGutter: 'stable' }
const caption: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: '0.9em' }

export default function WorkflowDiagram({ original, parser, t }: { original: string; parser: WorkflowScriptParser; t: CodingNsTranslator }) {
  const { name, nodes, partial } = useMemo(() => readWorkflowApprovalPreview(original, parser, t), [original, parser, t])
  return h(Fragment, null,
    name ? h('strong', { style: { overflowWrap: 'anywhere' } }, name) : null,
    nodes.length ? h('div', { style: diagramSize, role: 'group', 'aria-label': t('workflow.approvalPreview.title'), tabIndex: 0 },
      h(WorkflowSteps, { nodes, sequence: true }))
      : h('span', { style: caption }, t('workflow.approvalPreview.empty')),
    nodes.length ? h('span', { style: caption }, partial ? t('workflow.approvalPreview.partial') : t('workflow.approvalPreview.static')) : null)
}

function WorkflowSteps({ nodes, sequence }: { nodes: readonly WorkflowPreviewNode[]; sequence: boolean }): ReactElement {
  const columns = !sequence && nodes.length > 1
  return h(sequence ? 'ol' : 'ul', {
    style: {
      display: 'grid', gap: sequence ? 0 : 5, padding: 0, margin: 0, listStyle: 'none',
      gridTemplateColumns: columns ? 'repeat(auto-fit, minmax(min(100%, 115px), 1fr))' : 'minmax(0, 1fr)',
    },
  }, nodes.map((node, index) => h('li', { key: index, style: { minWidth: 0 } },
    sequence && index > 0 ? h('div', { 'aria-hidden': true, style: { ...caption, lineHeight: '16px', paddingInlineStart: 12 } }, '↓') : null,
    h('div', {
      style: {
        ...box, display: 'grid', gap: 4,
        background: node.kind === 'phase' ? dshThemeColor.surfaceSubtle : undefined,
        borderStyle: node.kind === 'hole' ? 'dashed' : 'solid',
      },
    },
    h('span', { style: { fontWeight: node.kind === 'action' ? 400 : 600 } }, node.label),
    node.children?.length ? h(WorkflowSteps, { nodes: node.children, sequence: node.kind !== 'parallel' && node.kind !== 'branch' }) : null))))
}

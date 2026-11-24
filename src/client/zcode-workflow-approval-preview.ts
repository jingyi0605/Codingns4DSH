import { resolveCodingNsTranslator, type CodingNsTranslator } from './locale.js'
import type { workflowScriptParser } from './editor-engine.js'

export interface WorkflowPreviewNode {
  readonly kind: 'phase' | 'branch' | 'case' | 'loop' | 'parallel' | 'async' | 'batch' | 'action' | 'hole'
  readonly label: string
  readonly children?: readonly WorkflowPreviewNode[]
}

export type WorkflowScriptParser = typeof workflowScriptParser
type Node = ReturnType<WorkflowScriptParser['parse']>['topNode']

export function readWorkflowApprovalPreview(original: string, parser: WorkflowScriptParser, t: CodingNsTranslator = resolveCodingNsTranslator()) {
  // The bridge appends the RPC input as a single JSON line after the provider's reason.
  const payload = original.trimEnd().split('\n').at(-1)
  let input: { name?: unknown; saved?: { name?: unknown }; script?: unknown } | undefined
  try { input = payload === undefined ? undefined : JSON.parse(payload) } catch { /* Older providers may send only a reason. */ }
  const name = compactLabel(input?.name ?? input?.saved?.name)
  const script = input?.script
  if (typeof script !== 'string' || script.length > 262_144) return { name, original, nodes: [], partial: false }

  let remaining = 96
  let partial = false
  const source = (node: Node | null) => node === null ? '' : script.slice(node.from, node.to)
  const called = (node: Node) => {
    const target = node.firstChild
    return target?.name === 'InstantiationExpression' ? target.firstChild : target
  }
  const args = (node: Node) => children(node.getChild('ArgList'))
    .filter(arg => !['(', ')', ',', 'LineComment', 'BlockComment'].includes(arg.name))
  const labelOf = (node: Node | undefined) => {
    if (node?.name !== 'String' && (node?.name !== 'TemplateString' || node.getChild('Interpolation') !== null)) return ''
    const literal = source(node)
    if (literal.startsWith('"')) {
      try { return compactLabel(JSON.parse(literal)) } catch { /* Keep a static label if the escape is JavaScript-specific. */ }
    }
    return compactLabel(literal.slice(1, -1).replace(/\\(['"`\\])/gu, '$1'))
  }
  function visit(node: Node, depth = 0): WorkflowPreviewNode[] {
    if (node.type.isError || depth > 96 || remaining <= 0) {
      partial = true
      return []
    }
    const visitChildren = (parent: Node | null) => children(parent).flatMap(child => visit(child, depth + 1))
    const item = (kind: WorkflowPreviewNode['kind'], label: string, children?: WorkflowPreviewNode[]): WorkflowPreviewNode[] => {
      if (remaining-- <= 0) {
        partial = true
        return []
      }
      return [{ kind, label, ...(children?.length ? { children } : {}) }]
    }
    if (node.name === 'IfStatement' || node.name === 'ConditionalExpression') {
      const parts = children(node).filter(child => !['if', 'else', 'LogicOp'].includes(child.name))
      const condition = parts.shift()
      const branches = parts.filter(child => !['?', ':'].includes(child.name)).map((child, index) => ({
        kind: 'case' as const, label: index === 0 ? t('workflow.approvalPreview.trueCase') : t('workflow.approvalPreview.elseCase'), children: visit(child, depth + 1),
      }))
      return [...(condition === undefined ? [] : visit(condition, depth + 1)),
        ...(branches.some(branch => branch.children.length) ? item('branch', t('workflow.approvalPreview.branch'), branches) : [])]
    }
    if (['ForStatement', 'WhileStatement', 'DoStatement'].includes(node.name)) {
      const steps = visitChildren(node)
      return steps.length ? item('loop', t('workflow.approvalPreview.loop'), steps) : []
    }
    if (node.name === 'CallExpression') {
      const target = called(node)
      const fn = source(target)
      const [first] = args(node)
      if (fn === 'phase') {
        const label = labelOf(first)
        return label ? item('phase', label) : []
      }
      if (fn === 'world.run') return item('action', labelOf(first) || t('workflow.approvalPreview.command'))
      if (fn === 'hole') return item('hole', labelOf(first) || t('workflow.approvalPreview.hole'))
      if (target?.name === 'MemberExpression' && source(target.lastChild) === 'ask') {
        const receiver = target.firstChild
        const actor = receiver?.name === 'CallExpression' && source(called(receiver)) === 'agent'
          ? labelOf(args(receiver)[0]) : compactLabel(source(receiver?.name === 'VariableName' ? receiver : null))
        return item('action', actor || t('workflow.approvalPreview.subagent'))
      }
      const steps = visitChildren(node)
      if (steps.length && /^Promise\.(all|allSettled|race|any)$/u.test(fn)) {
        const label = fn === 'Promise.race' || fn === 'Promise.any' ? t('workflow.approvalPreview.race') : t('workflow.approvalPreview.parallel')
        return item('parallel', label, steps)
      }
      if (steps.length && fn === 'future') return item('async', t('workflow.approvalPreview.async'), steps)
      if (steps.length && target?.name === 'MemberExpression' && source(target.lastChild) === 'map') {
        return item('batch', t('workflow.approvalPreview.batch'), steps)
      }
      return steps
    }
    // Declarations have no known execution position until invoked.
    if (node.name === 'FunctionDeclaration' || node.name === 'ClassDeclaration'
      || node.name === 'ArrowFunction' && node.parent?.name === 'VariableDeclaration') {
      partial = true
      return []
    }
    return visitChildren(node)
  }
  const nodes = visit(parser.parse(script).topNode)
  return { name, original, nodes, partial }
}

function children(node: Node | null): Node[] {
  const result: Node[] = []
  for (let child = node?.firstChild; child != null; child = child.nextSibling) result.push(child)
  return result
}

function compactLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  const label = value.replace(/\s+/gu, ' ').trim()
  return label.length > 96 ? label.slice(0, 95) + '…' : label
}

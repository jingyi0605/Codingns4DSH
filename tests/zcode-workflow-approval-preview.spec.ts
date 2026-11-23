import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowScriptParser } from '../src/client/editor-engine.ts'
import { readWorkflowApprovalPreview as readPreview } from '../src/client/zcode-workflow-approval-preview.ts'

const readWorkflowApprovalPreview = (reason: string) => readPreview(reason, workflowScriptParser)

function detail(script: string, name = '交付前复核'): string {
  return 'CreateWorkflow requires approval\n' + JSON.stringify({ name, script, path: 'draft.ts' })
}

test('审批正文生成阶段图，保留原始申请供展开查看', () => {
  const reason = detail(`
  // phase("注释")
  const instruction = \`phase("提示词里的示例")\`
  phase("准备")
  const ready = await agent("检查").ask<boolean>(instruction)
  if (ready) {
    phase("构建")
    await world.run("pnpm", ["build"])
  } else {
    phase("补充材料")
  }
  phase("复核")
  await Promise.all([agent("格式").ask("复核"), agent("事实").ask("复核")])
  `)
  const preview = readWorkflowApprovalPreview(reason)
  assert.equal(preview.name, '交付前复核')
  assert.equal(preview.original, reason)
  assert.deepEqual(preview.nodes.map(node => [node.kind, node.label]), [
    ['phase', '准备'], ['action', '检查'], ['branch', '条件分支'], ['phase', '复核'], ['parallel', '并行执行'],
  ])
  assert.deepEqual(preview.nodes[2]?.children?.map(node => node.children?.[0]?.label), ['构建', '补充材料'])
  assert.deepEqual(preview.nodes[4]?.children?.map(node => node.label), ['格式', '事实'])
})

test('循环、动态分发、命令与待补步骤保留各自含义', () => {
  const preview = readWorkflowApprovalPreview(detail(`
    for (let i = 0; i < 3; i++) {
      phase("迭代")
      await Promise.all(items.map(item => agent(\`review-\${item.id}\`).ask<Result>(item.text)))
    }
    await world.run("git", ["status"])
    await hole<Result>("复核结果", "等待输入")
  `))
  assert.deepEqual(preview.nodes.map(node => node.kind), ['loop', 'action', 'hole'])
  assert.equal(preview.nodes[0]?.children?.[1]?.children?.[0]?.kind, 'batch')
})

test('路径及旧版缺少脚本的申请保留可读的空态', () => {
  const preview = readWorkflowApprovalPreview('pending\n{"saved":{"name":"质量检查"}}')
  assert.equal(preview.name, '质量检查')
  assert.deepEqual(preview.nodes, [])
  assert.deepEqual(readWorkflowApprovalPreview('pending\n{"script":"phase("}').nodes, [])
})

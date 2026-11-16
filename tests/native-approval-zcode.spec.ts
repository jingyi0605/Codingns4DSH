import assert from 'node:assert/strict'
import test from 'node:test'
import { zcodePermissionMode } from '../data/build/dist/host/cli-adapters/zcode-interactions.js'
import { resolveNativeApprovalPermission } from '../data/build/dist/shared/native-approval-modes.js'

test('ZCode native choices map to guarded/build/plan/edit/yolo, with planning taking priority', () => {
  for (const [nativeApprovalMode, expected] of [
    ['manual', 'build'], ['auto-review', 'guarded'], ['read-only', 'plan'],
    ['accept-edits', 'edit'], ['full-access', 'yolo'],
  ] as const) {
    const permission = resolveNativeApprovalPermission({ adapterId: 'zcode', nativeApprovalMode }, { sandboxMode: 'read-only', approvalPolicy: 'ask' })
    const input = { sessionId: 'mode', messages: [], prompt: 'test', permission }
    assert.equal(zcodePermissionMode(input), expected)
    assert.equal(zcodePermissionMode({ ...input, plan: true }), 'plan')
  }
  for (const nativeApprovalMode of [undefined, 'inherit'] as const) {
    const permission = resolveNativeApprovalPermission({ adapterId: 'zcode', nativeApprovalMode }, { sandboxMode: 'read-only', approvalPolicy: 'never' })
    assert.equal(zcodePermissionMode({ sessionId: 'legacy', messages: [], prompt: 'test', permission }), 'plan')
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'
import { ZCODE_WORKFLOW_APPROVAL_QUESTION_ID } from '../src/shared/contracts/zcode-workflow.js'

test('CreateWorkflow grants stay scoped to ZCode requests and obey the native approval policy', async () => {
  const agent = { id: 'workflow-session', session: {} }
  let mode = 'ask'
  let normal = 0
  let workflows = 0
  let handleApproval: ((pending: object, next: () => string) => Promise<string>) | undefined
  const services = {
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    approval: {
      effectivePolicy: () => mode,
      async request(pending: object) {
        if (mode === 'never') return 'rejected'
        const next = () => { normal++; return 'allowed-once' }
        return handleApproval === undefined ? next() : handleApproval(pending, next)
      },
    },
    userQuestions: {
      async ask(request: { questions: Array<{ id: string; intent: { always: string } }> }) {
        workflows++
        assert.equal(request.questions[0]?.id, ZCODE_WORKFLOW_APPROVAL_QUESTION_ID)
        return { answers: [{ id: ZCODE_WORKFLOW_APPROVAL_QUESTION_ID, selected: [request.questions[0]?.intent.always] }] }
      },
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get: (name: keyof typeof services) => services[name],
    on(name: string, callback: NonNullable<typeof handleApproval>) {
      if (name === 'approval/request') handleApproval = callback
      return () => { handleApproval = undefined }
    },
  } as never)
  const request = { requestId: 'workflow-1', toolName: 'CreateWorkflow', reason: 'Preview a workflow' }
  assert.equal(await bridge.requestCreateWorkflowApproval?.(agent.id, request, 'offer-session'), 'allowed-for-session')
  assert.equal(await bridge.requestCreateWorkflowApproval?.(agent.id, request, 'session-granted'), 'allowed-once')
  mode = 'never'
  assert.equal(await bridge.requestCreateWorkflowApproval?.(agent.id, request, 'session-granted'), 'policy-rejected')
  mode = 'ask'
  const other = { requestId: 'edit-1', toolName: 'Write' }
  assert.equal(await bridge.requestCreateWorkflowApproval?.(agent.id, other, 'session-granted'), 'allowed-once')
  assert.equal(workflows, 1)
  assert.equal(normal, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

for (const { splitToolSteps, preface } of [
  { splitToolSteps: true, preface: true },
  { splitToolSteps: true, preface: false },
  { splitToolSteps: false, preface: true },
]) {
  test(`Codex 提问前后正文保留原生历史顺序：分段=${splitToolSteps}，前文=${preface}`, async () => {
    const history = []
    const sessionId = 'codex-question-order'
    const question = { id: 'quiz_answer', question: '2 + 3 等于多少？', options: [{ label: '5' }, { label: '6' }] }
    let turnStarts = 0
    let questionCount = 0
    let answer: unknown
    let step = 0
    const driver = new CodexAppServerDriver({
      binaries: ['fake-codex'],
      spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
      spawn: (() => {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const notification = (method: string, params: Record<string, unknown>): void => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: 'question-thread', turnId: 'question-turn', ...params } })}\n`)
        }
        const text = (itemId: string, delta: string): void => notification('item/agentMessage/delta', { itemId, delta })
        const stdin = { write(data: string): void {
          const request = JSON.parse(data) as { id: number; method?: string; result?: unknown }
          if (request.method === 'turn/start') {
            turnStarts += 1
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'question-turn', status: 'inProgress' } } })}\n`)
            if (preface) text('assistant-before', '先用提问组件出题。')
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0', id: 0, method: 'item/tool/requestUserInput',
              params: { threadId: 'question-thread', turnId: 'question-turn', itemId: 'question-call', questions: [question] },
            })}\n`)
            return
          }
          if (request.method === undefined && request.id === 0) {
            answer = request.result
            notification('serverRequest/resolved', { requestId: 0 })
            text('assistant-after', '你回答了 5，正确。')
            notification('turn/completed', { turn: { id: 'question-turn', status: 'completed' } })
            return
          }
          const result = request.method === 'thread/start' ? { thread: { id: 'question-thread' } } : {}
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
        } }
        return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
      }) as never,
    })

    try {
      let continued: boolean
      do {
        continued = false
        step += 1
        assert.ok(step <= 3, '同一次提问不得产生重复分段')
        const projector = new CodingNsDshMessageProjector({
          adapterId: 'codex', sessionId,
          nativeSessions: {
            appendToolCall(_sessionId, call) {
              history.push({ type: 'tool/call', step, call })
              return { sessionId, turn: 1, step, callId: call.callId, callSeq: history.length }
            },
            appendToolResult(handle, result) {
              history.push({ type: 'tool/result', step: handle.step, callId: handle.callId, result })
              return true
            },
            async askQuestions(_sessionId, request) {
              questionCount += 1
              assert.deepEqual(request.questions, [question])
              assert.equal(request.requestId, '0')
              return { requestId: request.requestId, answers: [{ id: 'quiz_answer', selected: ['5'] }] }
            },
          },
          respondQuestion(response) { driver.respondQuestion(sessionId, response) },
        })
        const chunks = []
        for await (const event of driver.executeTurn({
          sessionId, messages: [], prompt: '测试提问', splitToolSteps,
          ...(step > 1 ? { resumeSegmentedTurn: true } : {}),
        })) {
          if (event.type === 'step-boundary') continued = true
          chunks.push(...await projector.push(event))
        }
        chunks.push(...await projector.complete())
        // 回放 DSH 的逐 step 结算：每次 llm/stream 完成才追加一条正文消息。
        const content = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').map((chunk) => chunk.block.text)
        if (content.length > 0) history.push({ type: 'assistant/message', step, content })
      } while (continued)

      assert.equal(turnStarts, 1, 'DSH 续段必须复用同一个 Codex turn')
      assert.equal(questionCount, 1)
      assert.deepEqual(answer, { answers: { quiz_answer: { answers: ['5'] } } })
      const call = history.find((event) => event.type === 'tool/call')
      const result = history.find((event) => event.type === 'tool/result')
      assert.equal(call.call.callId, 'question-call')
      assert.equal(result.callId, call.call.callId)
      assert.deepEqual(JSON.parse(result.result.output).providerAnswers, [['5']])

      if (splitToolSteps && preface) {
        assert.deepEqual(history.map(({ type, step }) => ({ type, step })), [
          { type: 'assistant/message', step: 1 },
          { type: 'tool/call', step: 2 },
          { type: 'tool/result', step: 2 },
          { type: 'assistant/message', step: 3 },
        ])
        assert.deepEqual(history[0].content, ['先用提问组件出题。'])
        assert.deepEqual(history[3].content, ['你回答了 5，正确。'])
      } else {
        assert.equal(step, 1, '缺少前文或没有启用分段时沿用原有单 step 回路')
        assert.deepEqual(history.map(({ type }) => type), ['tool/call', 'tool/result', 'assistant/message'])
        assert.deepEqual(history[2].content, preface ? ['先用提问组件出题。', '你回答了 5，正确。'] : ['你回答了 5，正确。'])
      }
    } finally {
      driver.dispose()
    }
  })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

// Real installed CLIs; only model responses are deterministic loopback fixtures.
const root = await mkdtemp(join(tmpdir(), 'codingns-rc4-real-cli-'))
const report = { directory: root, model: 'loopback protocol fixture', cases: [], requests: [], failures: [] }
const children = new Set()
let active
const observedSpawn = (command, args, options) => {
  const child = spawn(command, args, options)
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
function sse(response, type, value) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
}
const server = createServer(async (request, response) => {
  try {
    const buffers = []
    for await (const chunk of request) buffers.push(chunk)
    const body = JSON.parse(Buffer.concat(buffers).toString())
    if (!active) { response.writeHead(503).end(); return }
    const current = active
    report.requests.push({ cli: current.cli, scenario: current.scenario, path: request.url,
      tools: body.tools?.map(tool => tool.name ?? tool.function?.name) })
    if (current.scenario === 'cancel' || current.scenario === 'abnormal-exit') {
      setTimeout(() => {
        if (current.scenario === 'cancel') current.controller.abort()
        else {
          current.killedAt = Date.now()
          for (const child of children) child.kill('SIGKILL')
        }
      }, 200)
      return
    }
    const interactive = ['question', 'permission-allow', 'permission-deny'].includes(current.scenario)
      && current.requests++ === 0
    const question = current.scenario === 'question'
    const toolName = current.cli === 'codex' ? question ? 'request_user_input' : 'exec_command'
      : question ? 'AskUserQuestion' : 'Bash'
    const args = question
      ? { questions: [{ id: 'choice', header: 'Compatibility', question: 'Continue this test?',
        options: [{ label: 'Continue', description: 'Finish the local test' }, { label: 'Stop', description: 'Stop the local test' }], multiSelect: false }] }
      : current.cli === 'codex'
        ? { cmd: `printf 'RC4_PERMISSION_PROBE' > approval-${current.scenario}.txt`, sandbox_permissions: 'require_escalated', justification: 'Check the explicit approval round trip.' }
        : { command: `printf 'RC4_PERMISSION_PROBE' > approval-${current.scenario}.txt`, description: 'Write the local acceptance marker' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (current.cli === 'claude-code') {
      const content = interactive ? { type: 'tool_use', id: `call_${current.scenario}`, name: toolName, input: {} }
        : { type: 'text', text: '' }
      const text = `RC4_OK_${current.scenario}`
      sse(response, 'message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant',
        model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 } } })
      sse(response, 'content_block_start', { index: 0, content_block: content })
      sse(response, 'content_block_delta', { index: 0, delta: interactive
        ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
        : { type: 'text_delta', text } })
      sse(response, 'content_block_stop', { index: 0 })
      sse(response, 'message_delta', { delta: { stop_reason: interactive ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
      sse(response, 'message_stop', {})
    } else {
      const id = `resp_${Date.now()}`
      const item = interactive
        ? { type: 'function_call', id: `fc_${current.scenario}`, call_id: `call_${current.scenario}`, name: toolName, arguments: JSON.stringify(args), status: 'completed' }
        : { type: 'message', id: `msg_${Date.now()}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `RC4_OK_${current.scenario}`, annotations: [] }] }
      const responseValue = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model,
        status: 'in_progress', output: [] }
      sse(response, 'response.created', { response: responseValue })
      sse(response, 'response.output_item.added', { output_index: 0, item: interactive ? { ...item, arguments: '' } : { ...item, content: [] } })
      if (interactive) {
        sse(response, 'response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
        sse(response, 'response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
      } else {
        sse(response, 'response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        sse(response, 'response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text })
        sse(response, 'response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text })
        sse(response, 'response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
      }
      sse(response, 'response.output_item.done', { output_index: 0, item })
      sse(response, 'response.completed', { response: { ...responseValue, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } })
    }
    response.end()
  } catch (error) {
    response.destroy(error)
  }
})
await new Promise(accept => server.listen(0, '127.0.0.1', accept))
const origin = `http://127.0.0.1:${server.address().port}`
try {
  for (const cli of ['codex', 'claude-code']) {
    const directory = join(root, cli)
    const config = join(directory, 'config')
    await mkdir(config, { recursive: true })
    if (cli === 'codex') await writeFile(join(config, 'config.toml'), [
      'model = "gpt-5.2"', 'model_provider = "fixture"',
      '[model_providers.fixture]', 'name = "Local compatibility fixture"',
      `base_url = "${origin}/v1"`, 'wire_api = "responses"', 'env_key = "RC4_LOCAL_API_KEY"',
      'supports_websockets = false', '[feedback]', 'enabled = false',
      `[projects.${JSON.stringify(directory)}]`, 'trust_level = "trusted"', '',
    ].join('\n'))
    else await writeFile(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    const runtimeEnv = cli === 'codex'
      ? { CODEX_HOME: config, RC4_LOCAL_API_KEY: 'fixture' }
      : { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: 'fixture',
        ANTHROPIC_AUTH_TOKEN: 'fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
    const driver = cli === 'codex'
      ? new CodexAppServerDriver({ codexHome: config, spawn: observedSpawn })
      : new ClaudeCodeDriver({ claudeConfigDir: config, sessionRoots: [join(config, 'projects')], spawn: observedSpawn })
    const detected = await driver.detect()
    assert.equal(detected.installed, true)
    report[cli] = { version: detected.version, command: detected.command }
    let providerSessionId
    try {
      for (const scenario of ['startup', 'continued-conversation', 'question', 'permission-allow', 'permission-deny', 'cancel', 'abnormal-exit']) {
        const controller = new AbortController()
        const deadline = setTimeout(() => controller.abort(new Error('Acceptance deadline')), 45_000)
        const events = []
        const nativeChunks = []
        const projector = new CodingNsDshMessageProjector({ adapterId: cli, sessionId: `${cli}-rc4-acceptance` })
        active = { cli, scenario, controller, requests: 0 }
        const startedAt = Date.now()
        let failure
        try {
          for await (const event of driver.executeTurn({
            sessionId: `${cli}-rc4-acceptance`, cwd: directory, runtimeEnv, providerSessionId,
            modelId: cli === 'codex' ? 'gpt-5.2' : 'claude-sonnet-4-6',
            prompt: `RC4_CASE_${scenario}. Follow the local model fixture.`, messages: [],
            signal: controller.signal, enableAskUserQuestion: true,
            permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
          })) {
            events.push(event)
            if (scenario === 'abnormal-exit') nativeChunks.push(...await projector.push(event))
            if (event.type === 'session-binding') providerSessionId = event.providerSessionId
            if (event.type === 'question-request') driver.respondQuestion(`${cli}-rc4-acceptance`, {
              requestId: event.requestId, answers: event.questions.map(question => ({ id: question.id, selected: ['Continue'] })),
            })
            if (event.type === 'permission-request') driver.respondPermission(`${cli}-rc4-acceptance`, {
              requestId: event.requestId, approved: scenario === 'permission-allow',
            })
          }
        } catch (error) {
          failure = { message: error.message }
          // Match the production feature boundary for drivers that reject on process exit.
          nativeChunks.push(...await projector.fail(error.message, controller.signal.aborted))
        }
        finally { clearTimeout(deadline) }
        const result = { cli, scenario, events, nativeChunks, elapsedMs: Date.now() - startedAt,
          ...(active.killedAt ? { exitToTerminalMs: Date.now() - active.killedAt } : {}),
          ...(failure ? { error: failure } : {}) }
        report.cases.push(result)
        await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
        try {
          const finish = events.findLast(event => event.type === 'finish')
          if (scenario === 'cancel') assert.equal(finish?.reason, 'cancel', JSON.stringify(result))
          else if (scenario === 'abnormal-exit') {
            if (cli === 'codex') {
              assert.equal(failure, undefined, JSON.stringify(result))
              assert.equal(finish?.reason, 'error', JSON.stringify(result))
              assert.equal(finish.failure?.code, 'PROVIDER_ERROR')
            }
            const nativeFinish = nativeChunks.findLast(chunk => chunk.type === 'finish')
            assert.equal(nativeFinish?.reason.kind, 'error', JSON.stringify(result))
            assert.equal(nativeFinish.reason.failure.code, 'PROVIDER_ERROR')
            assert.equal(nativeChunks.filter(chunk => chunk.type === 'finish').length, 1)
            assert.ok(result.exitToTerminalMs < 5000, JSON.stringify(result))
          } else {
            assert.equal(failure, undefined, JSON.stringify(result))
            assert.equal(finish?.reason, 'stop', JSON.stringify(result))
            assert.ok(events.some(event => event.type === 'text-delta' && event.text.includes('RC4_OK')), JSON.stringify(result))
            if (scenario === 'question') assert.ok(events.some(event => event.type === 'question-request'), JSON.stringify(result))
            if (scenario.startsWith('permission-')) {
              assert.ok(events.some(event => event.type === 'permission-request'), JSON.stringify(result))
              const marker = await readFile(join(directory, `approval-${scenario}.txt`), 'utf8')
                .catch(error => { if (error.code === 'ENOENT') return null; throw error })
              assert.equal(marker, scenario === 'permission-allow' ? 'RC4_PERMISSION_PROBE' : null)
              result.permissionEffect = scenario === 'permission-allow' ? 'marker written' : 'write prevented'
            }
            assert.ok(providerSessionId)
          }
          result.status = 'passed'
          console.log(`${cli} ${detected.version}: ${scenario} passed`)
        } catch (error) {
          result.status = 'failed'
          result.assertion = error.message
          report.failures.push({ cli, scenario, message: error.message })
          console.error(`${cli} ${detected.version}: ${scenario} failed`)
        }
      }
    } finally { driver.dispose() }
  }
  assert.equal(report.failures.length, 0, JSON.stringify(report.failures))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = { message: error.message, stack: error.stack }
  throw error
} finally {
  active = undefined
  for (const child of children) child.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise(accept => server.close(accept))
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(`CLI lifecycle evidence: ${join(root, 'report.json')}`)
}

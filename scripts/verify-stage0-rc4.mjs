import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [startupLog, artifacts] = process.argv.slice(2)
assert.ok(startupLog && artifacts, 'Supply the private Stage0 startup log and fixture directory.')
const directory = await realpath(artifacts)
assert.ok(directory.startsWith('/private/tmp/'))
const repository = fileURLToPath(new URL('../', import.meta.url))
const pid = execFileSync('lsof', ['-t', '-iTCP:17891', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
assert.match(pid, /^\d+$/u)
const command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' })
assert.ok(command.includes('--profile stage0'))
assert.equal(await realpath(command.match(/--patch\s+(\S+)/u)[1]), await realpath(join(repository, 'dsh-stage0.patch.yml')))
assert.ok(command.includes('/0.2.2-rc.4/'))
const environment = execFileSync('ps', ['eww', '-o', 'command=', '-p', pid], { encoding: 'utf8' })
assert.equal(environment.match(/(?:^|\s)DSH_HOME=([^\s]*)/u)?.[1], join(homedir(), '.dsh-stage0-020'))
const origin = 'http://127.0.0.1:17891'
const log = await readFile(startupLog, 'utf8')
const loginUrl = [...log.matchAll(/http:\/\/127\.0\.0\.1:17891\/[^\s\x1b]*/gu)]
  .map(match => new URL(match[0])).findLast(url => url.searchParams.has('token'))
assert.ok(loginUrl)
const login = await fetch(loginUrl, { redirect: 'manual' })
assert.equal(login.status, 303)
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function rpc(method, payload = {}, plugin = false) {
  const response = await fetch(`${origin}/${plugin ? 'codingns' : 'api'}/${method}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(60_000),
  })
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`)
  const result = (await response.json()).result
  assert.equal(result?.ok, true, `${method}: ${JSON.stringify(result?.error)}`)
  return result.value
}
const native = (method, request) => rpc(`session/${method}`, { args: { request } })
async function waitForSnapshot(sessionId, turn) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const error = await readFile(join(directory, `${sessionId}.error.json`), 'utf8').catch(() => null)
    assert.equal(error, null, error)
    const snapshot = await readFile(join(directory, `${sessionId}.json`), 'utf8').then(JSON.parse).catch(() => null)
    if (snapshot?.terminal.turn === turn) return snapshot
    await new Promise(accept => setTimeout(accept, 100))
  }
  throw new Error(`No terminal fixture snapshot for ${sessionId}, turn ${turn}`)
}
const report = { runtime: '0.2.2-rc.4', sourceSha: '3f321d32bfe382212a8ed8785c1d47a5a300aa23',
  plugin: JSON.parse(await readFile(new URL('../version.json', import.meta.url))).pluginVersion,
  pid, startupMethod: command, cases: [], unverified: ['Desktop', 'Windows', 'Linux', 'public Relay network'] }
const settings = await rpc('settings/get', {}, true)
assert.ok(settings.value && typeof settings.value === 'object')
report.settings = 'passed: active plugin settings returned'
const catalog = await rpc('cli/catalog', {}, true)
report.cli = catalog.filter(item => ['codex', 'claude-code'].includes(item.id))
  .map(({ id, installed, enabled, version }) => ({ id, installed, enabled, version }))
try {
  for (const [model, code] of [['rc4-refusal', 'CONTENT_REFUSED'], ['rc4-malformed', 'MALFORMED_RESPONSE']]) {
    const workspace = join(directory, model)
    await mkdir(workspace, { recursive: true })
    const { sessionId } = await native('create', { cwd: workspace })
    await native('selectModel', { sessionId, provider: 'codingns-rc4-fixture', model })
    await native('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Exercise the local fixture.' }] })
    const snapshot = await waitForSnapshot(sessionId, 1)
    assert.equal(snapshot.terminal.reason.kind, 'error')
    assert.equal(snapshot.terminal.reason.error.code, code)
    assert.equal(snapshot.events.filter(event => event.type === 'assistant/message').length, 0)
    assert.equal(snapshot.messages.some(message => message.role === 'assistant'), false)
    assert.deepEqual(snapshot.cold, snapshot.live)
    assert.deepEqual(snapshot.checkpoint, snapshot.live)
    if (model === 'rc4-refusal') {
      assert.equal(snapshot.live.tokenUsage.outputTokens, 5)
      assert.equal(snapshot.live.tokenUsage.uncachedInputTokens, 12)
      const attempts = snapshot.events.filter(event => event.type === 'assistant/attempt')
      assert.equal(attempts.length, 1)
      assert.equal(attempts[0].data.stream.filter(record => record.chunk?.type === 'usage').length, 1)
      await native('selectModel', { sessionId, provider: 'codingns-rc4-fixture', model: 'rc4-success' })
      await native('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Continue after the failed attempt.' }] })
      const continued = await waitForSnapshot(sessionId, 2)
      assert.equal(continued.terminal.reason.kind, 'completed')
      assert.ok(JSON.stringify(continued.messages).includes('RC4_SUCCESS'))
      assert.ok(!JSON.stringify(continued.messages).includes('RC4_UNACCEPTED_DRAFT'))
      assert.equal(continued.live.tokenUsage.outputTokens, 10)
      assert.equal(continued.live.tokenUsage.uncachedInputTokens, 24)
      assert.deepEqual(continued.cold, continued.live)
      report.cases.push({ model, sessionId, refusal: 'passed', billing: 'passed', history: 'passed',
        replay: 'passed', continuedConversation: 'passed' })
    } else report.cases.push({ model, sessionId, originalErrorCode: 'passed', replay: 'passed' })
  }
  const deadline = Date.now() + 5000
  let receipts = []
  while (Date.now() < deadline) {
    receipts = await readFile(join(directory, 'webhook-receipts.json'), 'utf8').then(JSON.parse).catch(() => [])
    if (receipts.length >= 3) break
    await new Promise(accept => setTimeout(accept, 50))
  }
  const refusal = report.cases.find(item => item.model === 'rc4-refusal')
  const failed = receipts.filter(item => item.session.id === refusal.sessionId && item.type === 'session.failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.errorCode, 'CONTENT_REFUSED')
  assert.equal(receipts.filter(item => item.session.id === refusal.sessionId && item.type === 'session.completed').length, 1,
    'Only the later successful turn may produce a completed notification')
  const requests = JSON.parse(await readFile(join(directory, 'provider-requests.json'), 'utf8'))
  assert.equal(requests.filter(item => item.model === 'rc4-refusal' && item.toolCount > 0).length, 1,
    'Count Agent requests independently of private title-generation calls')
  assert.ok(requests.every(item => item.safetyCheck === undefined))
  report.webhook = 'passed: actual local HTTP delivery; duplicate native terminal intentionally injected'
  report.providerRequests = requests
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { message: error.message, stack: error.stack }
  throw error
} finally {
  await writeFile(join(directory, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}

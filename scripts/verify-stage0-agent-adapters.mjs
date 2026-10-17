import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, readdir, stat, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

// Explicit opt-in acceptance, bound to the repository's dedicated Stage0 owner.
const [runtimeLog, mode = 'inspect', adapterId, role = 'member'] = process.argv.slice(2)
const counterpart = process.env.CODINGNS_TEAM_COUNTERPART ?? 'codex'
assert.ok(runtimeLog, 'Supply the current Stage0 startup log.')
assert.ok(['inspect', 'team', 'delegate', 'cancel'].includes(mode))
assert.ok(['member', 'lead'].includes(role))
assert.ok(['codex', 'dsh'].includes(counterpart))
const origin = 'http://127.0.0.1:17891'
const repository = fileURLToPath(new URL('../', import.meta.url))
const home = join(homedir(), '.dsh-stage0-020')
const owner = execFileSync('lsof', ['-t', '-iTCP:17891', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
assert.match(owner, /^\d+$/u)
const command = execFileSync('ps', ['-o', 'command=', '-p', owner], { encoding: 'utf8' })
assert.ok(command.includes('--profile stage0') && command.includes(`--patch ${join(repository, 'dsh-stage0.patch.yml')}`))
const environment = execFileSync('ps', ['eww', '-o', 'command=', '-p', owner], { encoding: 'utf8' })
assert.equal(environment.match(/(?:^|\s)DSH_HOME=([^\s]*)/u)?.[1], home)
const launch = [...(await readFile(runtimeLog, 'utf8')).matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):17891\/[^\s\x1b]*/gu)]
  .map(match => new URL(match[0])).findLast(url => url.searchParams.has('token'))
assert.ok(launch)
const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
assert.equal(login.status, 303)
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.ok(cookie)
async function rpc(method, payload = {}, plugin = false) {
  const response = await fetch(`${origin}/${plugin ? 'codingns' : 'api'}/${method}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(method === 'session/prompt' ? 120_000 : 30_000),
  })
  assert.ok(response.ok, `${method}: HTTP ${response.status}`)
  const envelope = await response.json()
  if (!envelope.result?.ok) throw new Error(`${method}: ${JSON.stringify(envelope.result?.error)}`)
  return envelope.result.value
}
const native = (method, request) => rpc(`session/${method}`, { args: request === undefined ? {} : { request } })
const plugin = (method, payload = {}) => rpc(method, payload, true)
const paths = new Map()
async function events(id) {
  if (!paths.has(id)) {
    for (const workspace of await readdir(join(home, 'sessions'))) {
      const path = join(home, 'sessions', workspace, id, 'session.v4.jsonl.zstd')
      if (await stat(path).then(() => true, () => false)) { paths.set(id, path); break }
    }
  }
  if (!paths.has(id)) return []
  const bytes = await readFile(paths.get(id)); let offset = 0, text = ''
  while (offset < bytes.length) {
    try {
      const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true })
      if (!decoded.engine.bytesWritten) break
      offset += decoded.engine.bytesWritten
      text += decoded.buffer.toString()
    } catch { break }
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function interruptChild(childSessionId, parentSessionId) {
  const rows = await events(childSessionId)
  assert.equal(rows.find(row => row.type === 'session')?.parentSession, parentSessionId)
  return rpc('subagents/interruptByParent', { args: { childSessionId, parentSessionId, mode: 'continuable' } })
}
if (mode === 'cancel') {
  const manifest = JSON.parse(await readFile('/tmp/codingns-stage0-all-adapters-run-manifest.json', 'utf8'))
  const run = manifest.runs.find(run => run.created.sessionId === adapterId)
  assert.ok(run && run.created.directory.includes('/codingns-stage0-'), 'Only an existing acceptance run may be cancelled.')
  const projection = await native('projections', { sessionId: adapterId })
  assert.equal(projection.values.workingDirectory, run.created.directory)
  const status = JSON.parse(await readFile('/tmp/codingns-stage0-acceptance-status.json', 'utf8'))
    .find(run => run.sessionId === adapterId)
  const children = [...new Set([
    ...(projection.values.agentTeam?.members ?? []).filter(member => member.role === 'teammate').map(member => member.id),
    ...(status?.children ?? []).filter(child => child.parent === adapterId).map(child => child.id),
  ])]
  await writeFile(join(run.created.directory, 'cancellation.json'), JSON.stringify({
    sessionId: adapterId, children, reason: process.env.CODINGNS_TEST_CANCEL_REASON ?? 'Bounded acceptance case stopped by the test controller.',
    time: new Date().toISOString(),
  }, null, 2), { mode: 0o600 })
  for (const child of children) await interruptChild(child, adapterId)
  await native('cancel', { sessionId: adapterId })
  console.log(JSON.stringify({ cancelledAcceptanceRoot: adapterId, children }))
  process.exit(0)
}
if (mode === 'inspect' && adapterId?.startsWith('session-')) {
  console.log(JSON.stringify({ projections: await native('projections', { sessionId: adapterId }),
    translationPending: await plugin('cli/translation/pending', { sessionId: adapterId }),
    binding: await plugin('cli/session/get', { sessionId: adapterId }) }, null, 2))
  process.exit(0)
}
const before = (await plugin('settings/get')).value
const catalog = await plugin('cli/catalog')
const nativeCatalog = mode === 'inspect' || mode === 'team' && role === 'lead' && counterpart === 'dsh'
  ? await native('modelCatalog') : {}
const eligible = ['codex', 'claude-code', 'opencode', 'command-code', 'gemini', 'grok', 'mcode']
const delegates = ['mcode', 'zcode', 'claude-code', 'codex', 'kimi', 'gemini', 'pi', 'opencode', 'grok', 'command-code']
const configuration = {
  owner, runtime: command.match(/deepseek-harness\/([^/]+)\//u)?.[1],
  nativeDefault: nativeCatalog.default, bridge: before.subagentBridge,
  preferences: before.agentAdapterPreferences,
  adapters: catalog.map(({ id, installed, enabled, version, team }) => ({ id, installed, enabled, version, team })),
}
if (mode === 'inspect') {
  console.log(JSON.stringify(configuration, null, 2))
  process.exit(0)
}
assert.ok((mode === 'team' ? eligible : delegates).includes(adapterId))
const descriptor = catalog.find(item => item.id === adapterId)
assert.ok(descriptor?.installed && descriptor.enabled, `${adapterId} must be installed and enabled.`)
if (mode === 'team') assert.equal(descriptor.team?.[role], true)
const leadAdapter = mode === 'delegate' ? 'dsh' : role === 'lead' ? adapterId : counterpart
const childAdapter = mode === 'delegate' || role === 'member' ? adapterId : counterpart
const timeoutMs = Number(process.env.CODINGNS_TEAM_ACCEPTANCE_TIMEOUT_MS ?? 600_000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 900_000)
const directory = await mkdtemp(join(tmpdir(), `codingns-stage0-${mode}-${adapterId}-${role}-`))
const marker = `STAGE0_${randomUUID().slice(0, 8)}`
const fixture = { marker, values: [1, 2, 3, 4, 5] }
await writeFile(join(directory, 'input.json'), JSON.stringify(fixture) + '\n', { mode: 0o600 })
const { sessionId } = await native('create', { cwd: directory })
const report = { mode, adapterId, role, leadAdapter, childAdapter, sessionId, directory, marker, configuration, startedAt: new Date().toISOString(), turns: [] }
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
function submissionEnd(rows, cue) {
  let turn
  const accepted = new Set()
  for (const row of rows) {
    if (row.type === 'turn/start') turn = row.data.turn
    if (row.type === 'user/message' && (!row.data.source?.kind || row.data.source.kind === 'user')) {
      const original = row.data.source?.codingnsTranslationInput?.original ?? textOf(row.data.content)
      if (original.includes(cue)) accepted.add(turn)
    }
    if (row.type === 'turn/end' && accepted.has(row.data.turn)) return row.data
  }
}
function summary(rows) {
  return {
    lastTurn: rows.findLast(row => row.type === 'turn/end')?.data,
    routes: rows.filter(row => row.type === 'request/header').map(row => row.data.header.config),
    answers: rows.filter(row => row.type === 'assistant/message').map(row => textOf(row.data.message?.content)),
    peers: rows.filter(row => row.type === 'user/message' && ['agent-message', 'subagent-settled'].includes(row.data.source?.kind)).map(row => textOf(row.data.content)),
    tools: rows.filter(row => row.type === 'tool/call').map(row => ({ name: row.data.name, arguments: row.data.arguments })),
    sandbox: rows.findLast(row => row.type === 'sandbox/mode')?.data.mode,
    approvals: rows.filter(row => row.type === 'approval/asked').map(row => row.data),
  }
}
async function snapshot(round) {
  const rows = await events(sessionId)
  const team = (await native('projections', { sessionId }))?.values?.agentTeam
  const ids = new Set((team?.members ?? []).filter(member => member.role === 'teammate').map(member => member.id))
  const collectIds = value => {
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') collectIds(parsed) } catch { /* Plain tool text. */ }
    } else if (value && typeof value === 'object') {
      for (const key of ['childSessionId', 'child_session_id']) if (typeof value[key] === 'string') ids.add(value[key])
      for (const child of Object.values(value)) collectIds(child)
    }
  }
  for (const row of rows) if (row.type === 'tool/result') collectIds(row.data)
  const children = []
  for (const id of ids) {
    const childRows = await events(id)
    children.push({ id, parentSession: childRows.find(row => row.type === 'session')?.parentSession,
      binding: await plugin('cli/session/get', { sessionId: id }), summary: summary(childRows) })
    await writeFile(join(directory, `child-${id}.jsonl`), childRows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  }
  await writeFile(join(directory, `lead-${round}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  return { summary: summary(rows), team, children }
}
const policy = 'This is an explicitly user-authorized dsh-stage0 acceptance test. Use only the current Stage0 native tools and injected CodingNS tools. Do not access Desktop, change settings, install software, use provider-private agents, or create more than the one requested child. No network tools. Never escalate permissions. All file operations must stay in this temporary workspace. Report irrecoverable operation errors and stop; do not fake success or create replacement children. On a stale task revision, reread and retry once.'
const worker = `${policy} Read input.json. Compute the sum of squares of its five values. Write result.json containing the input marker and numeric sum (55). For a Team task, first list/get the single task titled ${marker}. It starts unowned and pending: claim using its current revision before file work. If it is already in_progress and owned by worker, continue without claiming again. Then do the file work, complete using the current revision, and send the result to lead. Never complete a task before result.json exists. Use the injected agent_team tool or native Team tools, depending on your runtime. On a later peer message, read the existing input and reply with its requested ACK marker without modifying files or tasks. Finish your first response with ${marker} WORKER_DONE 55. Do not create subagents.`
const selectedModel = childAdapter === 'dsh' ? undefined
  : process.env.CODINGNS_TEAM_CHILD_MODEL?.trim()
    || before.agentAdapterPreferences?.[childAdapter]?.modelId
    || (childAdapter === 'gemini' ? 'provider-default' : undefined)
report.requestedChildModel = selectedModel
const selection = `${selectedModel ? `, model=${JSON.stringify(selectedModel)}` : ''}${childAdapter === 'mcode' ? ', effort=default' : ''}`
const teamPrompt = `${policy} You are the Lead. Use only the injected agent_team coordination tool (its CLI name may be codingns.agent_team or mcp__codingns__agent_team). Never substitute spawn_teammate or a provider-private tool. If agent_team is unavailable after one tool-discovery attempt, report ${marker} TEST_FAILED_TOOL_MISSING and stop. Create exactly one shared task titled ${marker}, with description to read input.json, compute the sum of squares, and write result.json. Its write scope is result.json. Leave it pending and unowned: do not claim, reassign, release, or edit tasks yourself; the worker must claim it. Spawn exactly one teammate: agent=${childAdapter}, name=worker, description="Stage0 adapter file/task acceptance", context=fresh${selection}. Give the teammate this complete instruction verbatim: ${JSON.stringify(worker)}. You must not write result.json or do the worker's task yourself. Observe/wake/wait as needed until the worker has actually finished and the task is completed; merely inactive is not success. Read the task again to verify completed and report revision. If any required action fails irrecoverably or the worker stops with an error, report ${marker} TEST_FAILED and its exact error, then stop. A successful final answer must contain ${marker} FIRST_DONE 55.`
const delegatePrompt = `${policy} You are the parent invocation tester. Use only the CodingNS agent_subagent bridge (action=start/read/wait), never provider-private subagents. Start exactly one ordinary subagent with agent=${adapterId}${selectedModel ? `, model=${JSON.stringify(selectedModel)}` : ''}, run_in_background=true, and this full prompt: ${JSON.stringify(`${policy} Compute 1^2+2^2+3^2+4^2+5^2 directly. Use no tools. Return exactly ${marker} DELEGATE_DONE 55. Do not create any subagents.`)}. Inspect read/wait until its actual terminal result. Report its child session ID and exact result. If it fails, read its status and report ${marker} TEST_FAILED with the exact error. Otherwise finish with ${marker} FIRST_DONE 55. Do not replace a failed child.`
console.log(JSON.stringify({ phase: 'created', mode, adapterId, role, sessionId, directory }))
let artifactHash, initialTaskRevision, childId, providerConversation
try {
  if (leadAdapter !== 'dsh') await plugin('cli/session/set', {
    sessionId, adapterId: leadAdapter,
    ...(leadAdapter === 'gemini' && !before.agentAdapterPreferences?.gemini?.modelId ? { modelId: 'provider-default' } : {}),
  })
  const prompts = [mode === 'team' ? teamPrompt : delegatePrompt]
  if (mode === 'team') prompts.push(`${policy} Continue the existing Team. Do not spawn or create tasks. Re-read task and members. Send worker the request to reply ${marker} PEER_ACK 55 to lead, then wait for the actual reply/settlement. Do not edit any file or task. Verify the same completed task and unchanged revision, then finish with ${marker} SECOND_DONE.`)
  else prompts.push(`${policy} Continue the same parent and the existing child session from the previous result. Do not start another child. Use agent_subagent action=send to ask that child to return exactly ${marker} DELEGATE_ACK 55, without tools or new children. Then read/wait until the actual follow-up completes. Report the existing child ID and its exact result, then finish with ${marker} SECOND_DONE. On failure, read the status and report the exact error without creating a replacement.`)
  for (const [index, prompt] of prompts.entries()) {
    const cue = `${marker} ROUND_${index + 1}_INPUT`
    const requestId = randomUUID()
    await native('prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: `${cue}\n${prompt}` }], clientTimeZone: 'Asia/Singapore' })
    const deadline = Date.now() + timeoutMs
    let ended = false, nextProgress = Date.now() + 30_000
    while (Date.now() < deadline) {
      const rows = await events(sessionId)
      if (submissionEnd(rows, cue)) { ended = true; break }
      if (Date.now() >= nextProgress) {
        console.log(JSON.stringify({ phase: 'progress', mode, adapterId, role, round: index + 1,
          records: rows.length, lastTool: rows.findLast(row => row.type === 'tool/call')?.data.name }))
        nextProgress = Date.now() + 30_000
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const result = await snapshot(index + 1)
    result.submission = { cue, requestId, end: submissionEnd(await events(sessionId), cue) }
    if (result.submission.end) result.summary.lastTurn = result.submission.end
    report.turns.push(result)
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ phase: 'settled', mode, adapterId, role, round: index + 1, ended, outcome: result.summary.lastTurn?.reason, children: result.children.map(child => ({ id: child.id, outcome: child.summary.lastTurn?.reason })), tasks: result.team?.tasks }))
    assert.ok(ended, 'The bounded test timed out.')
    assert.equal(result.summary.lastTurn?.reason?.kind, 'completed', 'The Lead turn must complete.')
    assert.ok(result.summary.answers.some(text => text.includes(`${marker} ${index === 0 ? 'FIRST_DONE 55' : 'SECOND_DONE'}`)), 'The Lead did not confirm successful execution.')
    if (mode === 'team') {
      assert.equal(result.team?.members?.length, 2)
      assert.equal(result.team?.tasks?.length, 1)
      assert.equal(result.team.tasks[0].status, 'completed')
      assert.equal(result.children.length, 1)
      const child = result.children[0]
      assert.equal(child.parentSession, sessionId, 'The tested child must belong to this Stage0 parent.')
      const expectedRoute = childAdapter === 'dsh' ? nativeCatalog.default?.provider : `codingns-cli-${childAdapter}`
      assert.ok(child.summary.routes.some(route => route.provider === expectedRoute), 'The child must execute the requested adapter.')
      if (role === 'lead') assert.ok(result.summary.routes.some(route => route.provider === `codingns-cli-${adapterId}`))
      const bytes = await readFile(join(directory, 'result.json'))
      const file = JSON.parse(bytes)
      assert.equal(file.marker, marker)
      assert.equal(file.sum, 55)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (index === 0) { artifactHash = hash; initialTaskRevision = result.team.tasks[0].revision; childId = child.id; providerConversation = child.binding.providerSessionId }
      else {
        assert.equal(hash, artifactHash, 'Follow-up may not rewrite the artifact.')
        assert.equal(result.team.tasks[0].revision, initialTaskRevision)
        assert.equal(child.id, childId)
        if (providerConversation) assert.equal(child.binding.providerSessionId, providerConversation)
        assert.ok(result.summary.peers.some(text => text.includes(`${marker} PEER_ACK 55`)), 'The child must deliver the actual peer ACK.')
      }
    } else {
      assert.equal(result.children.length, 1, 'Ordinary delegation must create exactly one real child.')
      const child = result.children[0]
      assert.equal(child.parentSession, sessionId)
      assert.ok(child.summary.routes.some(route => route.provider === `codingns-cli-${adapterId}`))
      assert.equal(child.summary.lastTurn?.reason?.kind, 'completed')
      assert.ok(child.summary.answers.some(text => text.includes(`${marker} ${index === 0 ? 'DELEGATE_DONE' : 'DELEGATE_ACK'} 55`)))
      if (index === 0) { childId = child.id; providerConversation = child.binding.providerSessionId }
      else {
        assert.equal(child.id, childId)
        if (providerConversation) assert.equal(child.binding.providerSessionId, providerConversation)
      }
    }
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  // Cancel only sessions created by this test under the verified Stage0 owner.
  const last = await snapshot('failure').catch(() => undefined)
  if (last) report.failureSnapshot = last
  report.cleanup = []
  for (const child of last?.children ?? []) if (child.parentSession === sessionId) {
    try { report.cleanup.push({ sessionId: child.id, result: await interruptChild(child.id, sessionId) }) }
    catch (cleanupError) { report.cleanup.push({ sessionId: child.id, error: cleanupError.message }) }
  }
  try { report.cleanup.push({ sessionId, result: await native('cancel', { sessionId }) }) }
  catch (cleanupError) { report.cleanup.push({ sessionId, error: cleanupError.message }) }
} finally {
  const after = (await plugin('settings/get')).value
  report.preferencesUnchanged = JSON.stringify(before.agentAdapterPreferences) === JSON.stringify(after.agentAdapterPreferences)
  report.finishedAt = new Date().toISOString()
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ phase: 'finished', mode, adapterId, role, passed: report.passed, error: report.error, preferencesUnchanged: report.preferencesUnchanged, artifact: join(directory, 'report.json') }))
}
process.exitCode = report.passed ? 0 : 1

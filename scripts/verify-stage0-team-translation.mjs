import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, stat, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Opt-in verification against the dedicated Stage0 instance, never Desktop.
const [runtimeLog, scenario = 'inspect'] = process.argv.slice(2)
assert.ok(runtimeLog, 'Pass the current Stage0 startup log; its launch token is never printed.')
const origin = 'http://127.0.0.1:17891'
const owner = execFileSync('lsof', ['-t', '-iTCP:17891', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
assert.match(owner, /^\d+$/u)
const command = execFileSync('ps', ['-o', 'command=', '-p', owner], { encoding: 'utf8' })
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
assert.ok(command.includes('--profile stage0') && command.includes(`--patch ${join(repositoryRoot, 'dsh-stage0.patch.yml')}`), 'The listener must be the repository Stage0 instance.')
const environment = execFileSync('ps', ['eww', '-o', 'command=', '-p', owner], { encoding: 'utf8' })
assert.equal(environment.match(/(?:^|\s)DSH_HOME=([^\s]*)/u)?.[1], join(homedir(), '.dsh-stage0-020'), 'The listener must own the dedicated Stage0 home.')
const log = await readFile(runtimeLog, 'utf8')
const launch = [...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):17891\/[^\s\x1b]*/gu)].map(match => new URL(match[0])).findLast(url => url.searchParams.has('token'))
assert.ok(launch, 'No Stage0 launch URL found in the supplied log.')
const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
assert.equal(login.status, 303, 'The current Stage0 launch token must be accepted.')
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.ok(cookie)

async function rpc(method, payload = {}, plugin = false) {
  const response = await fetch(`${origin}/${plugin ? 'codingns' : 'api'}/${method}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  assert.ok(response.ok, `${method}: HTTP ${response.status}: ${text.slice(0, 300)}`)
  const envelope = JSON.parse(text)
  if (!envelope.result?.ok) throw Object.assign(new Error(`${method}: ${JSON.stringify(envelope.result?.error)}`), { code: envelope.result?.error?.code })
  return envelope.result.value
}
const native = (method, request) => rpc(`session/${method}`, { args: request === undefined ? {} : { request } })
const plugin = (method, payload = {}) => rpc(method, payload, true)
async function setBilingual(value) {
  for (let attempt = 0; ; attempt++) {
    const current = await plugin('settings/get')
    try {
      return await plugin('settings/set', { expectedRevision: current.revision, ops: [{
        op: 'set', path: ['sessionTranslation'], value: { ...current.value.sessionTranslation, bilingual: value },
      }] })
    } catch (error) {
      if (error.code !== 'SETTINGS_CONFLICT' || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}
const settings = (await plugin('settings/get')).value
const catalog = await plugin('cli/catalog')
const nativeCatalog = await native('modelCatalog')
const configuration = {
  module: settings.modules?.sessionTranslation,
  translation: settings.sessionTranslation,
  preferences: Object.fromEntries(['codex', 'opencode', 'grok', 'dsh'].map(id => [id, settings.agentAdapterPreferences?.[id]])),
  bridge: settings.subagentBridge,
  nativeDefault: nativeCatalog.default,
  adapters: catalog.filter(item => ['codex', 'opencode', 'claude-code', 'grok'].includes(item.id)).map(({ id, version, installed, team }) => ({ id, version, installed, team })),
}
if (scenario === 'inspect') {
  console.log(JSON.stringify(configuration, null, 2))
} else {
  const scenarios = { 'codex-codex': ['codex', 'codex'], 'opencode-codex': ['opencode', 'codex'], 'codex-native': ['codex', 'dsh'], 'codex-grok': ['codex', 'grok'] }
  const selected = scenarios[scenario]
  assert.ok(selected, 'Unknown Stage0 acceptance scenario.')
  assert.equal(configuration.module, true)
  assert.equal(settings.sessionTranslation?.nativeEnabled, true)
  const [lead, backend] = selected
  assert.equal(catalog.find(item => item.id === lead)?.team?.lead, true)
  if (backend !== 'dsh') assert.equal(catalog.find(item => item.id === backend)?.team?.member, true)
  if (backend !== 'grok') assert.equal(settings.agentAdapterPreferences?.[lead]?.translationEnabled, true)
  const directory = await mkdtemp(join(tmpdir(), 'codingns-spec0074-stage0-team-'))
  const marker = `TEAM_TRANSLATION_${randomUUID().slice(0, 8)}`
  const created = await native('create', { cwd: directory })
  const sessionId = created.sessionId
  const refresh = process.env.CODINGNS_TEAM_TRANSLATION_REFRESH === '1'
  const mixedInput = process.env.CODINGNS_TEAM_MIXED_INPUT === '1'
  const report = { scenario, sessionId, directory, marker, configuration, refresh, mixedInput, turns: [], changes: [] }
  let restoreBilingual = false
  let steered = false
  await plugin('cli/session/set', { sessionId, adapterId: lead, ...(backend === 'grok' ? {} : { translationEnabled: true }) })
  const timeoutMs = Number(process.env.CODINGNS_TEAM_ACCEPTANCE_TIMEOUT_MS ?? 600_000)
  assert.ok(timeoutMs >= 10_000 && timeoutMs <= 600_000)
  const files = new Map()
  async function events(id) {
    if (!files.has(id)) {
      const root = join(homedir(), '.dsh-stage0-020/sessions')
      for (const workspace of await readdir(root)) {
        const path = join(root, workspace, id, 'session.v4.jsonl.zstd')
        if (await stat(path).then(() => true, () => false)) { files.set(id, path); break }
      }
    }
    if (!files.has(id)) return []
    const bytes = await readFile(files.get(id)); let offset = 0; let text = ''
    while (offset < bytes.length) {
      try {
        const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true })
        if (!decoded.engine.bytesWritten) break
        offset += decoded.engine.bytesWritten; text += decoded.buffer.toString()
      } catch { break } // An in-progress append may end in a partial final frame.
    }
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  const textOf = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  function summary(rows) {
    const inputs = rows.filter(row => row.type === 'user/message')
    const answers = rows.filter(row => row.type === 'assistant/message')
    const positions = new Map(); let position
    for (const row of rows) {
      if (row.type === 'step/start') position = { turn: row.data.turn, step: row.data.step }
      else if (row.type === 'step/end') position = undefined
      else if (row.type === 'user/message' && position) positions.set(row, position)
    }
    return {
      lastTurn: rows.findLast(row => row.type === 'turn/end')?.data,
      translatedInputs: inputs.map(row => row.data.source?.codingnsTranslationInput).filter(Boolean),
      translatedHostMessages: inputs.filter(row => row.data.source?.codingnsTranslationContext).length,
      translatedOutputBlocks: answers.flatMap(row => row.data.message?.content ?? []).filter(block => block.codingnsTranslation).length,
      failedTranslations: [...inputs.map(row => row.data.source?.codingnsTranslationInput), ...answers.flatMap(row => row.data.message?.content ?? []).map(block => block.codingnsTranslation)].filter(record => record?.failed).length,
      mixedBatches: inputs.filter(row => row.data.source?.codingnsTranslationInput?.original?.includes('HUMAN_MIXED_NOTE')).map(row => {
        const batch = positions.get(row)
        return { ...batch, withTeamInput: Boolean(batch) && inputs.some(other => positions.get(other)?.turn === batch.turn
          && positions.get(other)?.step === batch.step && ['agent-message', 'subagent-settled'].includes(other.data.source?.kind)) }
      }),
      peerMessages: inputs.filter(row => row.data.source?.kind === 'agent-message').map(row => textOf(row.data)),
      settlementNotices: inputs.filter(row => row.data.source?.kind === 'subagent-settled').map(row => textOf(row.data)),
      answers: answers.map(row => textOf(row.data.message)).filter(Boolean),
      toolCalls: rows.filter(row => row.type === 'tool/call').map(row => ({ name: row.data.name, arguments: row.data.arguments })),
      routes: rows.filter(row => row.type === 'request/header').map(row => row.data.header.config),
      sandboxMode: rows.findLast(row => row.type === 'sandbox/mode')?.data.mode,
      approvalPolicy: rows.findLast(row => row.type === 'approval/policy')?.data.policy,
      approvals: rows.filter(row => row.type === 'approval/asked').map(row => row.data.toolName),
    }
  }
  console.log(JSON.stringify({ phase: 'created', scenario, sessionId, directory }))
  const prompts = [
    `请测试原生 DSH 智能体团队，标记 ${marker}。你是 Lead。只使用注入的 agent_team 团队工具，禁止 shell、文件操作、网络工具和供应商私有子代理。先创建一个共享任务，要求独立计算 1²+2²+3²+4²+5²。然后只创建一名 teammate：agent=${backend}，name=reviewer，description="Read-only arithmetic and Team translation test"，context=fresh。给它完整英文指令：读取任务，用当前 expectedRevision 和 taskAction=claim 领取，独立计算，通过 message target=lead 发送结果 55，再读取新 revision 并 complete。不要让它创建其他代理。Lead 必须等待队友的完成通知并核实任务 completed，最终英文回复必须包含 ${marker} FIRST_DONE 和结果 55。工具失败请报告原始错误，不要重复 spawn。`,
    `继续同一个团队，不要创建新任务或新队友。请读取已有任务和成员。通过 agent_team message 给 reviewer 发送消息，请它回复英文标记 ${marker} PEER_ACK 并确认结果 55。等待它处理消息完成后，再读取任务，确认之前的 completed 状态和 revision 没有被改写。最终英文回复包含 ${marker} SECOND_DONE 和原任务 revision。仍禁止 shell、文件和网络操作。`,
  ]
  try {
    for (const [index, prompt] of prompts.entries()) {
      await native('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'Asia/Singapore', content: [{ type: 'text', text: prompt }] })
      if (refresh && index === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        await setBilingual(!configuration.translation.bilingual)
        restoreBilingual = true
        report.changes.push({ event: 'translation-refresh', time: new Date().toISOString() })
        await new Promise(resolve => setTimeout(resolve, 4500))
        await setBilingual(configuration.translation.bilingual)
        restoreBilingual = false
        report.changes.push({ event: 'translation-restored', time: new Date().toISOString() })
      }
      const deadline = Date.now() + timeoutMs; let rows = []
      while (Date.now() < deadline) {
        rows = await events(sessionId)
        if (mixedInput && index === 0 && !steered) {
          const pending = rows.findLastIndex(row => row.type === 'agent/inbox/spliced' && row.data.target === 'next-step' && row.data.inserted?.some(message => ['agent-message', 'subagent-settled'].includes(message.source?.kind)))
          const consumed = rows.findLastIndex(row => row.type === 'agent/inbox/spliced' && row.data.target === 'next-step' && row.data.removedCount)
          if (pending > consumed) {
            await native('prompt', { sessionId, requestId: randomUUID(), mode: 'steer', content: [{ type: 'text', text: `HUMAN_MIXED_NOTE：请处理队友的消息并确认已收到人的补充指令，不要重建任务或队友。完成后仍必须回复 ${marker} FIRST_DONE 和结果 55。` }] })
            steered = true
            report.changes.push({ event: 'human-input-with-pending-Team-message', time: new Date().toISOString() })
          }
        }
        if (rows.filter(row => row.type === 'turn/end').length > index) break
        await new Promise(resolve => setTimeout(resolve, mixedInput && !steered ? 100 : 2000))
      }
      const result = summary(rows)
      const projection = await native('projections', { sessionId })
      const team = projection?.values?.agentTeam
      const children = []
      for (const member of team?.members ?? []) if (member.role === 'teammate') children.push({ member, session: summary(await events(member.id)) })
      report.turns.push({ result, team, children })
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
      await writeFile(join(directory, `lead-turn-${index + 1}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ phase: 'settled', scenario, turn: index + 1, outcome: result.lastTurn?.reason, members: team?.members?.length, tasks: team?.tasks, translatedInputs: result.translatedInputs.length, translatedOutputBlocks: result.translatedOutputBlocks, artifact: join(directory, 'report.json') }))
      assert.equal(result.lastTurn?.reason?.kind, 'completed', 'Lead must complete without a translation or Team error.')
      assert.equal(team?.members?.length, 2, 'The Team must contain exactly one reviewer.')
      assert.equal(team?.tasks?.length, 1, 'No replacement task may hide a continuation failure.')
      assert.ok(team.tasks.some(task => task.status === 'completed'), 'The reviewer must complete its task.')
      assert.ok(result.answers.some(text => text.includes(`${marker} ${index === 0 ? 'FIRST' : 'SECOND'}_DONE`)), 'Lead must return the requested completion marker.')
      if (backend !== 'grok') assert.ok(result.translatedInputs.length > index, 'The real translation service must process each human input.')
      if (backend === 'grok') {
        assert.equal(children.length, 1)
        assert.ok(children[0].session.routes.some(route => route.provider === 'codingns-cli-grok'), 'The reviewer must actually execute Grok.')
        assert.equal(children[0].session.sandboxMode, 'workspace-write')
        assert.equal(children[0].session.approvalPolicy, 'never')
        assert.ok(!children[0].session.approvals.includes('codingns__agent_team'), 'Bound Team coordination must not request additional native approval.')
      }
      if (index === 1) {
        assert.ok(result.peerMessages.some(text => text.includes('PEER_ACK')), 'A resumed teammate must reply to the Lead.')
        assert.equal(team.tasks[0].revision, report.turns[0].team.tasks[0].revision, 'A follow-up must preserve the completed task revision.')
      }
      if (mixedInput && index === 0) {
        assert.ok(steered, 'The mixed-input probe must reach an actual pending Team message.')
        assert.ok(result.translatedInputs.some(record => record.original.includes('HUMAN_MIXED_NOTE')), 'Human steering input must still be translated.')
      }
    }
    report.passed = true
    console.log(JSON.stringify({ phase: 'passed', scenario, sessionId, artifact: join(directory, 'report.json') }))
  } catch (error) {
    report.error = error.message
    const members = (await native('projections', { sessionId }).catch(() => null))?.values?.agentTeam?.members ?? []
    for (const id of new Set([sessionId, ...members.filter(member => member.role === 'teammate').map(member => member.id)])) await native('cancel', { sessionId: id }).catch(() => {})
    throw error
  } finally {
    if (restoreBilingual) await setBilingual(configuration.translation.bilingual)
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  }
}

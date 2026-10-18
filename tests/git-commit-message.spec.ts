import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import type { AssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { DEFAULT_GIT_MANAGEMENT_SETTINGS } from '../src/shared/contracts/git.js'
import { generateGitCommitMessage } from '../src/host/features/git-commit-message.js'
import { createGitManagementFeature } from '../src/host/features/git-management.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'

const execFile = promisify(execFileCallback)
const primary = { provider: 'native', model: 'primary', label: 'Native / Primary' }
const backup = { provider: 'native', model: 'backup', label: 'Native / Backup' }
const catalog = { models: [primary, backup], default: primary, errors: [] }
const signal = () => new AbortController().signal

test('Git generation tries its own models in priority order and applies the selected detail level', async () => {
  const attempts: string[] = []
  const adapter: AssistantLlmAdapter = {
    catalog: async () => { throw new Error('Explicit model pools do not need the default catalog') },
    async reply(model, system, messages) {
      attempts.push(model.model)
      assert.match(system, /detailed bullet list/u)
      assert.equal(messages[0]?.text, 'staged diff')
      if (model.model === primary.model) throw new Error('Provider unavailable')
      return 'Update Git settings\n\n- Add generation controls\n- Keep translation preferences isolated'
    },
  }
  const result = await generateGitCommitMessage(adapter, { ...DEFAULT_GIT_MANAGEMENT_SETTINGS,
    commitMessageDetail: 'detailed', commitMessageModels: [primary, backup],
  }, 'staged diff', signal())
  assert.deepEqual(attempts, ['primary', 'backup'])
  assert.match(result.message, /\n\n- Add generation controls/u)
})

test('an empty Git pool follows the DSH default and concise output has no body', async () => {
  const adapter: AssistantLlmAdapter = {
    catalog: async () => ({ ...catalog, default: backup }),
    async reply(model, system) {
      assert.equal(model.model, backup.model)
      assert.match(system, /only the single subject line/u)
      return '```text\nUpdate Git settings\n\nUnwanted body\n```'
    },
  }
  assert.deepEqual(await generateGitCommitMessage(adapter, DEFAULT_GIT_MANAGEMENT_SETTINGS, 'diff', signal()), { message: 'Update Git settings' })
})

test('invalid results fall back and complete failure is reported', async () => {
  const attempts: string[] = []
  const adapter: AssistantLlmAdapter = {
    catalog: async () => catalog,
    async reply(model) { attempts.push(model.model); return ' ' },
  }
  await assert.rejects(generateGitCommitMessage(adapter, { ...DEFAULT_GIT_MANAGEMENT_SETTINGS, commitMessageModels: [primary, backup] }, 'diff', signal()), { code: 'GIT_GENERATION_FAILED' })
  assert.deepEqual(attempts, ['primary', 'backup'])
  await assert.rejects(generateGitCommitMessage(adapter, { ...DEFAULT_GIT_MANAGEMENT_SETTINGS,
    commitMessageModels: [{ provider: 'codex', model: 'external' }],
  }, 'diff', signal()), { code: 'GIT_MODEL_UNAVAILABLE' })
})

test('cancellation stops generation even if the provider ignores the signal', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const adapter: AssistantLlmAdapter = {
    catalog: async () => catalog,
    reply: async () => { started(); return new Promise<string>(() => undefined) },
  }
  const abort = new AbortController()
  const pending = generateGitCommitMessage(adapter, DEFAULT_GIT_MANAGEMENT_SETTINGS, 'diff', abort.signal)
  await ready
  abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('Git RPC generates from staged changes, respects enablement, and accepts detailed commits', async (t) => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-generation-`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (args: string[]) => execFile('git', args, { cwd: root })
  await git(['init'])
  await git(['config', 'user.name', 'CodingNS Test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await writeFile(`${root}/staged.txt`, 'STAGED_MARKER\n')
  await git(['add', 'staged.txt'])
  await writeFile(`${root}/staged.txt`, 'STAGED_MARKER\nUNSTAGED_MARKER\n')
  await writeFile(`${root}/untracked.txt`, 'UNTRACKED_MARKER\n')
  let requests = 0
  const message = `Improve Git settings\n\n${'- Add independent controls and model priorities.\n'.repeat(8)}`.trim()
  const adapter: AssistantLlmAdapter = {
    catalog: async () => catalog,
    async reply(model, system, messages) {
      requests++
      assert.equal(model.model, 'backup')
      assert.match(system, /detailed bullet list/u)
      assert.match(messages[0]!.text, /STAGED_MARKER/u)
      assert.doesNotMatch(messages[0]!.text, /UNSTAGED_MARKER|UNTRACKED_MARKER/u)
      return message
    },
  }
  const settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { sessionTranslation: false },
    gitManagement: { ...DEFAULT_GIT_MANAGEMENT_SETTINGS, commitMessageDetail: 'detailed' as const, commitMessageModels: [backup] },
  }
  Object.defineProperty(settings, 'sessionTranslation', { get() { throw new Error('Git must not read translation settings') } })
  const table = new CodingNsRpcTable()
  const disposers: Array<() => void | Promise<void>> = []
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose() })
  const feature = createGitManagementFeature({ llm: adapter })
  feature.start({ descriptor: feature.descriptor, resources: { add: (dispose) => { disposers.push(dispose) } }, services: {
    rpc: table, settings: { get: () => settings } as never, resolveWorkspaceRoot: () => root,
  } })
  const call = (endpoint: string, payload: unknown = {}) => {
    const target = table.resolve(endpoint)!
    return target.handler(target.action, payload, { signal: signal() })
  }
  assert.deepEqual(await call('git/models'), catalog)
  const draft = await call('git/generate-message', { workspaceId: 'workspace' }) as { message: string }
  assert.equal(draft.message, message)
  await assert.rejects(git(['rev-parse', '--verify', 'HEAD']))
  settings.gitManagement = { ...settings.gitManagement, commitMessageEnabled: false }
  await assert.rejects(call('git/generate-message', { workspaceId: 'workspace' }), { code: 'GIT_GENERATION_DISABLED' })
  assert.equal(requests, 1)
  await call('git/commit', { workspaceId: 'workspace', subject: draft.message })
  assert.equal((await git(['log', '-1', '--format=%B'])).stdout.trim(), message)
  settings.gitManagement = { ...settings.gitManagement, commitMessageEnabled: true }
  await assert.rejects(call('git/generate-message', { workspaceId: 'workspace' }), { code: 'GIT_NOTHING_STAGED' })
  assert.equal(requests, 1)
})

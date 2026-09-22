import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClaudeCodeDriver } from '../dist/host/cli-adapters/claude-driver.js'
import { CodexAppServerDriver } from '../dist/host/cli-adapters/codex-driver.js'
import { CommandCodeDriver } from '../dist/host/cli-adapters/command-code-driver.js'
import { GeminiCliDriver } from '../dist/host/cli-adapters/gemini-driver.js'
import { GrokBuildDriver } from '../dist/host/cli-adapters/grok-driver.js'
import { KimiCliDriver } from '../dist/host/cli-adapters/kimi-driver.js'
import { OpenCodeDriver } from '../dist/host/cli-adapters/opencode-driver.js'
import { PiAgentDriver } from '../dist/host/cli-adapters/pi-driver.js'

function fixture(): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codingns-probe-'))
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

function write(path: string, content: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

test('Claude 探测区分可用、已删除和损坏的原始会话', async () => {
  const files = fixture()
  try {
    const id = 'claude-session-1'
    const path = join(files.root, 'project', `${id}.jsonl`)
    write(path, `${JSON.stringify({ type: 'user', sessionId: id })}\n`)
    const driver = new ClaudeCodeDriver({ sessionRoots: [files.root] })
    assert.deepEqual(await driver.probeSession({ providerSessionId: id }), {
      state: 'available', reason: 'Provider 原始会话可用', rawStoreRef: path,
    })
    assert.equal((await driver.probeSession({ providerSessionId: 'deleted' })).state, 'missing')
    write(path, `${JSON.stringify({ type: 'user', sessionId: 'other' })}\n`)
    assert.equal((await driver.probeSession({ providerSessionId: id, rawStoreRef: path })).state, 'corrupt')
  } finally { files.dispose() }
})

test('旧 rawStoreRef 删除后继续扫描权威目录并发现已移动会话', async () => {
  const files = fixture()
  try {
    const id = 'claude-moved-session'
    const movedPath = join(files.root, 'archived', `${id}.jsonl`)
    write(movedPath, `${JSON.stringify({ type: 'user', sessionId: id })}\n`)
    const driver = new ClaudeCodeDriver({ sessionRoots: [files.root] })
    assert.deepEqual(await driver.probeSession({
      providerSessionId: id,
      rawStoreRef: join(files.root, 'active', `${id}.jsonl`),
    }), {
      state: 'available',
      reason: 'Provider 原始会话可用',
      rawStoreRef: movedPath,
    })
  } finally { files.dispose() }
})

test('旧 rawStoreRef 内容已损坏或被复用时仍扫描权威目录', async () => {
  const files = fixture()
  try {
    const id = 'claude-reused-session'
    const oldPath = join(files.root, 'active', `${id}.jsonl`)
    const movedPath = join(files.root, 'archived', `${id}.jsonl`)
    write(oldPath, `${JSON.stringify({ type: 'user', sessionId: 'another-session' })}\n`)
    write(movedPath, `${JSON.stringify({ type: 'user', sessionId: id })}\n`)
    const driver = new ClaudeCodeDriver({ sessionRoots: [files.root] })

    assert.deepEqual(await driver.probeSession({ providerSessionId: id, rawStoreRef: oldPath }), {
      state: 'available',
      reason: 'Provider 原始会话可用',
      rawStoreRef: movedPath,
    })
  } finally { files.dispose() }
})

test('磁盘会话探测响应取消信号，不在超时后继续扫描', async () => {
  const files = fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    const driver = new ClaudeCodeDriver({ sessionRoots: [files.root] })
    await assert.rejects(
      driver.probeSession({ providerSessionId: 'cancelled', signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
  } finally { files.dispose() }
})

test('Kimi 和 Gemini 按各自原生目录格式验证会话', async () => {
  const files = fixture()
  try {
    const kimiId = 'kimi-session-1'
    const kimiPath = join(files.root, 'kimi', 'workspace-hash', kimiId, 'context.jsonl')
    write(kimiPath, `${JSON.stringify({ id: 0, role: 'system' })}\n`)
    const kimi = new KimiCliDriver({ sessionRoots: [join(files.root, 'kimi')] })
    assert.deepEqual(await kimi.probeSession({ providerSessionId: kimiId }), {
      state: 'available', reason: 'Provider 原始会话可用', rawStoreRef: join(files.root, 'kimi', 'workspace-hash', kimiId),
    })

    const geminiId = '26f8acca-7dc1-49ad-b80c-233c3afac316'
    const geminiPath = join(files.root, 'gemini', 'project', 'chats', 'session-2026-09-22T00-00-26f8acca.jsonl')
    write(geminiPath, `${JSON.stringify({ kind: 'session', sessionId: geminiId })}\n`)
    const gemini = new GeminiCliDriver({ sessionRoots: [join(files.root, 'gemini')] })
    assert.deepEqual(await gemini.probeSession({ providerSessionId: geminiId }), {
      state: 'available', reason: 'Provider 原始会话可用', rawStoreRef: geminiPath,
    })
  } finally { files.dispose() }
})

test('Codex、Pi 和 Grok 只读核对原生持久化记录', async () => {
  const files = fixture()
  try {
    const codexId = 'codex-thread-1'
    const codexPath = join(files.root, 'codex', '2026', '09', '22', `rollout-${codexId}.jsonl`)
    write(codexPath, `${JSON.stringify({ type: 'session_meta', payload: { id: codexId } })}\n`)
    const codex = new CodexAppServerDriver({ sessionRoots: [join(files.root, 'codex')] })
    assert.equal((await codex.probeSession({ providerSessionId: codexId })).state, 'available')

    const piId = 'pi-session-1'
    const piPath = join(files.root, 'pi', '--workspace--', `2026-09-22_${piId}.jsonl`)
    write(piPath, `${JSON.stringify({ type: 'session', id: piId })}\n`)
    const pi = new PiAgentDriver({ sessionRoots: [join(files.root, 'pi')] })
    assert.equal((await pi.probeSession({ providerSessionId: piId })).state, 'available')

    const grokId = 'grok-session-1'
    const grokPath = join(files.root, 'grok', '%2Fworkspace', grokId, 'updates.jsonl')
    write(grokPath, '')
    const grok = new GrokBuildDriver({ sessionRoots: [join(files.root, 'grok')] })
    assert.deepEqual(await grok.probeSession({ providerSessionId: grokId }), {
      state: 'available', reason: 'Provider 原始会话可用', rawStoreRef: join(files.root, 'grok', '%2Fworkspace', grokId),
    })
  } finally { files.dispose() }
})

test('OpenCode 仅把权威 404 认定为删除，服务异常认定为不可达', async () => {
  const available = new OpenCodeDriver({
    binaries: [], serverUrls: ['http://opencode.test'],
    fetch: async (url: string) => {
      if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
      if (url.endsWith('/session/remote-1')) return new Response(JSON.stringify({ id: 'remote-1' }), { status: 200 })
      return new Response('{}', { status: 404 })
    },
  })
  assert.equal((await available.probeSession({ providerSessionId: 'remote-1' })).state, 'available')
  assert.equal((await available.probeSession({ providerSessionId: 'deleted' })).state, 'missing')

  const offline = new OpenCodeDriver({
    binaries: [], serverUrls: ['http://offline.test'], fetch: async () => { throw new Error('offline') },
  })
  assert.equal((await offline.probeSession({ providerSessionId: 'remote-1' })).state, 'unreachable')
})

test('无绑定会话保持未知，Command Code 明确标记为临时会话', async () => {
  const files = fixture()
  try {
    const claude = new ClaudeCodeDriver({ sessionRoots: [files.root] })
    assert.equal((await claude.probeSession({})).state, 'unknown')
    const command = new CommandCodeDriver({ binaries: [] })
    assert.equal((await command.probeSession({ providerSessionId: 'ignored' })).state, 'ephemeral')
  } finally { files.dispose() }
})

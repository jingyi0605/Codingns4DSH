import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { startSubagentBridgeServer } from '../data/build/dist/host/cli-bridge/bridge-server.js'
import { dispatchBridgeSearch } from '../data/build/dist/host/cli-bridge/search-dispatch.js'
import { bridgeMcpEntryPath } from '../data/build/dist/host/cli-bridge/injections.js'
import commandCodeMod from '../data/build/dist/host/cli-bridge/command-code-mod.js'

function sourceEntry(path: string): string {
  return existsSync(path) ? path : path.replace(/\.js$/u, '.ts')
}

function bridgeEntryArgs(): string[] {
  return ['--import', fileURLToPath(new URL('./register-source-loader.mjs', import.meta.url)), sourceEntry(bridgeMcpEntryPath())]
}

function stubWeb(queries: string[] = []) {
  return {
    async search(request: { readonly query: string; readonly maxResults: number }, signal: AbortSignal) {
      signal.throwIfAborted()
      queries.push(request.query)
      return {
        content: `snippet for ${request.query}`,
        sources: [{ url: `https://example.com/${encodeURIComponent(request.query)}`, title: request.query, snippet: 'hello' }],
        truncated: false,
      }
    },
  }
}

test('dispatchBridgeSearch validates queries, deduplicates, and marks results untrusted', async () => {
  const seen: string[] = []
  const missing = await dispatchBridgeSearch({ queries: ['公开资料'] }, {})
  assert.equal(missing.ok, false)
  assert.match(String(missing.error), /unavailable/u)

  const invalid = await dispatchBridgeSearch({ queries: [] }, { web: stubWeb() })
  assert.equal(invalid.ok, false)
  assert.match(String(invalid.error), /1 to 4/u)

  const tooLong = await dispatchBridgeSearch({ queries: ['x'.repeat(1001)] }, { web: stubWeb() })
  assert.equal(tooLong.ok, false)

  const result = await dispatchBridgeSearch({ queries: ['  公开资料  ', '公开资料', '第二问'] }, { web: stubWeb(seen) })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['公开资料', '第二问'])
  assert.match(result.text, /untrusted reference material/u)
  assert.match(result.text, /https:\/\/example.com/u)
  assert.equal(result.results?.results.length, 2)
})

test('dispatchBridgeSearch cancels sibling queries when one search fails', async () => {
  let cancelled = false
  const result = await dispatchBridgeSearch({ queries: ['失败查询', '挂起查询'] }, {
    web: {
      async search(request: { readonly query: string }, signal: AbortSignal) {
        if (request.query === '失败查询') throw new Error('provider error')
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
        })
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /provider error/u)
  assert.equal(cancelled, true)
})

test('桥接 /v1/search 接受运行时令牌与 Team 令牌，并拒绝未授权请求', async () => {
  const seen: string[] = []
  const caller = {}
  const lifetime = new AbortController()
  const server = await startSubagentBridgeServer({
    dispatch: async () => { throw new Error('unexpected dispatch') },
    teamAccess: (sessionId) => sessionId === 'root' ? {
      caller, signal: lifetime.signal, identity: { sessionId, teamId: 'root', name: 'lead', role: 'lead' },
    } : undefined,
    teamDispatch: async () => ({ ok: true, result: {} }),
    search: (input, signal) => dispatchBridgeSearch(input, { web: stubWeb(seen) }, signal),
  })
  try {
    const unauthorized = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: ['公开资料'] }),
    })
    assert.equal(unauthorized.status, 401)

    const wrong = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer deadbeef', 'content-type': 'application/json' },
      body: JSON.stringify({ queries: ['公开资料'] }),
    })
    assert.equal(wrong.status, 401)

    const runtime = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queries: ['公开资料'] }),
    })
    assert.equal(runtime.status, 200)
    const runtimeBody = await runtime.json() as { ok: boolean; text: string }
    assert.equal(runtimeBody.ok, true)
    assert.match(runtimeBody.text, /untrusted reference material/u)

    const teamToken = server.runtime.teamSession?.('root')?.token
    assert.ok(teamToken)
    const team = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${teamToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queries: ['第二问'] }),
    })
    assert.equal(team.status, 200)
    assert.equal((await team.json() as { ok: boolean }).ok, true)
    assert.deepEqual(seen, ['公开资料', '第二问'])

    const invalid = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queries: [] }),
    })
    assert.equal(invalid.status, 200)
    assert.equal((await invalid.json() as { ok: boolean }).ok, false)
  } finally {
    lifetime.abort()
    await server.close()
  }
})

test('桥接 /v1/search 在未装配搜索派发时返回 503', async () => {
  const server = await startSubagentBridgeServer({
    dispatch: async () => { throw new Error('unexpected dispatch') },
  })
  try {
    const response = await fetch(`${server.runtime.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queries: ['公开资料'] }),
    })
    assert.equal(response.status, 503)
  } finally {
    await server.close()
  }
})

test('MCP web_search 经过 Host /v1/search 返回不可信来源', async () => {
  const server = await startSubagentBridgeServer({
    dispatch: async () => { throw new Error('unexpected dispatch') },
    search: (input, signal) => dispatchBridgeSearch(input, { web: stubWeb() }, signal),
  })
  const child = spawn(process.execPath, bridgeEntryArgs(), {
    env: {
      ...process.env,
      CODINGNS_BRIDGE_URL: server.runtime.baseUrl,
      CODINGNS_BRIDGE_TOKEN: server.runtime.token,
      CODINGNS_DSH_SESSION_ID: 's1',
      CODINGNS_ADAPTER_ID: 'claude-code',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new Map<unknown, any>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') responses.set(JSON.parse(line).id, JSON.parse(line))
      index = buffer.indexOf('\n')
    }
  })
  const send = (message: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  const waitFor = async (id: number): Promise<any> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (responses.has(id)) return responses.get(id)
      await delay(50)
    }
    throw new Error(`MCP 响应超时: ${String(id)}`)
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'web_search', arguments: { queries: ['公开资料'] } } })
    const tools = await waitFor(1)
    assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === 'web_search'))
    const call = await waitFor(2)
    assert.equal(call.result.isError, undefined)
    assert.match(String(call.result.content?.[0]?.text), /untrusted reference material/u)
    assert.match(String(call.result.content?.[0]?.text), /公开资料/u)
  } finally {
    child.kill()
    await server.close()
  }
})

test('Command Code Mod 在普通会话与 Team 会话都注册 web_search', async () => {
  const previous = { ...process.env }
  try {
    process.env.CODINGNS_DISABLE_NATIVE_AGENT = '1'
    process.env.CODINGNS_BRIDGE_URL = 'http://127.0.0.1:1'
    process.env.CODINGNS_BRIDGE_TOKEN = 'token'
    process.env.CODINGNS_DSH_SESSION_ID = 's1'
    delete process.env.CODINGNS_TEAM_TOKEN
    const ordinary: Array<{ schema: { name: string } }> = []
    commandCodeMod({ addTool: (tool: { schema: { name: string } }) => ordinary.push(tool), hooks: () => undefined })
    assert.ok(ordinary.some((tool) => tool.schema.name === 'web_search'))

    process.env.CODINGNS_TEAM_TOKEN = 'team-token'
    process.env.CODINGNS_TEAM_ROLE = 'lead'
    process.env.CODINGNS_TEAM_NAME = 'lead'
    const team: Array<{ schema: { name: string } }> = []
    commandCodeMod({ addTool: (tool: { schema: { name: string } }) => team.push(tool), hooks: () => undefined })
    assert.deepEqual(team.map((tool) => tool.schema.name), ['agent_team', 'web_search'])
  } finally {
    process.env = previous
  }
})

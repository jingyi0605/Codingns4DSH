import assert from 'node:assert/strict'
import test from 'node:test'
import { describeWebFailure, isRetryableWebFailure } from '../data/build/dist/host/cli-bridge/web-diagnostics.js'
import { dispatchBridgeSearch } from '../data/build/dist/host/cli-bridge/search-dispatch.js'
import { dispatchBridgeFetch } from '../data/build/dist/host/cli-bridge/fetch-dispatch.js'
import { claudeAllowedBridgeTools, claudeBridgeArgs, bridgeSearchGuidance, bridgeFetchGuidance } from '../data/build/dist/host/cli-bridge/injections.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'

/** undici 的真实失败形态：`TypeError: fetch failed`，原因在 cause 上。 */
function fetchFailed(cause: unknown): Error {
  return Object.assign(new TypeError('fetch failed'), { cause })
}

test('describeWebFailure unwraps fetch failed causes and classifies retryability', () => {
  const dns = describeWebFailure(fetchFailed({ code: 'ENOTFOUND', hostname: 'api.deepseek.com' }))
  assert.equal(dns.retryable, true)
  assert.deepEqual(dns.causes, ['ENOTFOUND'])
  assert.match(String(dns.detail), /^fetch failed \(transport error ENOTFOUND, target api\.deepseek\.com\)/u)
  assert.match(String(dns.detail), /retry of the same call may succeed/u)

  const timeout = describeWebFailure(fetchFailed({ code: 'UND_ERR_CONNECT_TIMEOUT', hostname: 'api.deepseek.com' }))
  assert.equal(timeout.retryable, true)
  assert.deepEqual(timeout.causes, ['UND_ERR_CONNECT_TIMEOUT'])

  const aggregate = describeWebFailure(fetchFailed(new AggregateError([
    Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', address: '203.0.113.9' }),
    Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', address: '203.0.113.9' }),
  ], 'connect ECONNREFUSED 203.0.113.9:443')))
  assert.equal(aggregate.retryable, true)
  assert.deepEqual(aggregate.causes, ['ECONNREFUSED'])
  assert.match(String(aggregate.detail), /target 203\.0\.113\.9/u)

  // provider 的结构化错误码优先级高于底层的“看起来可重试”的痕迹。
  const missing = Object.assign(new Error('DeepSeek search has no API key'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING', cause: { code: 'ENOTFOUND' } })
  assert.equal(isRetryableWebFailure(missing), false)
  const missingFailure = describeWebFailure(missing)
  assert.equal(missingFailure.retryable, false)
  assert.match(String(missingFailure.detail), /Retrying the same call will not help/u)

  const misconfigured = Object.assign(new Error('provider settings do not resolve'), { code: 'WEB_PROVIDER_MISCONFIGURED' })
  assert.equal(isRetryableWebFailure(misconfigured), false)

  const rejected = Object.assign(new Error('DeepSeek error (HTTP 401): Authentication Fails'), { status: 401 })
  assert.equal(isRetryableWebFailure(rejected), false)
  assert.match(String(describeWebFailure(rejected).detail), /upstream returned HTTP 401/u)

  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  assert.equal(isRetryableWebFailure(aborted), false)
  const timedOut = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  assert.match(String(describeWebFailure(timedOut).detail), /timed out/u)

  // 没有任何 cause 的 fetch failed 仍然值得再试一次；普通业务错误不重试。
  assert.equal(isRetryableWebFailure(Object.assign(new TypeError('fetch failed'), {})), true)
  assert.equal(isRetryableWebFailure(new Error('provider error')), false)
})

test('dispatchBridgeSearch retries a transport failure once and succeeds on the second attempt', async () => {
  const attempts: string[] = []
  const result = await dispatchBridgeSearch({ queries: ['Dynamics CRM Set-CrmCertificate'] }, {
    web: {
      async search() {
        attempts.push('call')
        if (attempts.length === 1) throw fetchFailed({ code: 'ECONNRESET', hostname: 'api.deepseek.com' })
        return { content: 'ok', sources: [{ url: 'https://learn.microsoft.com/a', title: 'a' }], truncated: false }
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 2)
  assert.equal(attempts.length, 2)
  assert.match(result.text, /https:\/\/learn\.microsoft\.com\/a/u)
})

test('dispatchBridgeSearch reports the cause and attempt count when retries are exhausted', async () => {
  let calls = 0
  const result = await dispatchBridgeSearch({ queries: ['x'] }, {
    web: {
      async search() {
        calls += 1
        throw fetchFailed({ code: 'UND_ERR_CONNECT_TIMEOUT', hostname: 'api.deepseek.com' })
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(calls, 2)
  assert.equal(result.attempts, 2)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.causes, ['UND_ERR_CONNECT_TIMEOUT'])
  assert.match(String(result.error), /fetch failed \(transport error UND_ERR_CONNECT_TIMEOUT, target api\.deepseek\.com\)/u)
})

test('dispatchBridgeSearch does not retry credential, configuration, or status failures', async () => {
  for (const [label, code, expectedCalls] of [
    ['WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_PROVIDER_CREDENTIAL_MISSING', 1],
    ['WEB_PROVIDER_MISCONFIGURED', 'WEB_PROVIDER_MISCONFIGURED', 1],
  ] as const) {
    let calls = 0
    const result = await dispatchBridgeSearch({ queries: [label] }, {
      web: {
        async search() {
          calls += 1
          throw Object.assign(new Error(`${label}: no usable DeepSeek key`), { code })
        },
      },
    })
    assert.equal(calls, expectedCalls)
    assert.equal(result.errorCode, code)
    assert.equal(result.retryable, false)
    assert.equal(result.attempts, 1)
  }

  let statusCalls = 0
  const status = await dispatchBridgeSearch({ queries: ['status'] }, {
    web: {
      async search() {
        statusCalls += 1
        throw Object.assign(new Error('DeepSeek error (HTTP 401): Authentication Fails (missing key)'), { status: 401 })
      },
    },
  })
  assert.equal(statusCalls, 1)
  assert.equal(status.retryable, false)
  assert.match(String(status.error), /HTTP 401/u)
})

test('dispatchBridgeSearch keeps sibling cancellation and stops retrying on caller abort', async () => {
  let cancelled = false
  const result = await dispatchBridgeSearch({ queries: ['失败查询', '挂起查询'] }, {
    web: {
      async search(request: { readonly query: string }, signal: AbortSignal) {
        if (request.query === '失败查询') throw Object.assign(new Error('DeepSeek error (HTTP 500)'), { status: 500 })
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
        })
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /HTTP 500/u)
  assert.equal(cancelled, true)

  const controller = new AbortController()
  let attempts = 0
  const aborted = dispatchBridgeSearch({ queries: ['abort'] }, {
    web: {
      async search() {
        attempts += 1
        controller.abort(new Error('user cancelled'))
        throw fetchFailed({ code: 'ECONNRESET' })
      },
    },
  }, controller.signal)
  const abortedResult = await aborted
  assert.equal(abortedResult.ok, false)
  assert.equal(attempts, 1)
})

test('dispatchBridgeFetch retries only connection-class failures and reports causes', async () => {
  let connectCalls = 0
  const recovered = await dispatchBridgeFetch({ url: 'https://example.com/page' }, {
    web: {
      async fetch() {
        connectCalls += 1
        if (connectCalls === 1) throw fetchFailed({ code: 'ENOTFOUND', hostname: 'example.com' })
        return { url: 'https://example.com/page', statusCode: 200, truncated: false, body: { kind: 'text', text: 'ok' } }
      },
    },
  })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.attempts, 2)

  // 正文阶段的断流不重试：抓取会把整页带宽翻倍。
  let resetCalls = 0
  const reset = await dispatchBridgeFetch({ url: 'https://example.com/big' }, {
    web: {
      async fetch() {
        resetCalls += 1
        throw fetchFailed({ code: 'ECONNRESET', hostname: 'example.com' })
      },
    },
  })
  assert.equal(resetCalls, 1)
  assert.equal(reset.retryable, true)
  assert.deepEqual(reset.causes, ['ECONNRESET'])
})

test('Claude Code always receives explicit bridge tool grants, and web guidance states the failure protocol', () => {
  assert.equal(claudeAllowedBridgeTools(false), 'mcp__codingns__agent_subagent,mcp__codingns__web_search,mcp__codingns__web_fetch')
  assert.equal(claudeAllowedBridgeTools(true), 'mcp__codingns__agent_team,mcp__codingns__web_search,mcp__codingns__web_fetch')

  const identity = { sessionId: 's1', teamId: 'team-1', name: 'lead', role: 'lead' as const }
  const teamRuntime = (team: boolean): ReturnType<typeof createSubagentBridgeRuntime> => createSubagentBridgeRuntime({
    baseUrl: 'http://127.0.0.1:45999',
    token: 'secret-token',
    ...(team ? {
      teamAccess: () => ({ caller: {}, signal: new AbortController().signal, identity }),
    } : {}),
  })
  try {
    // 普通会话：没有 Team 令牌也必须拿到联网工具授权。
    setSubagentBridge(teamRuntime(false))
    const ordinary = claudeBridgeArgs('s1', 'claude-code')
    const allowedIndex = ordinary.indexOf('--allowedTools')
    assert.ok(allowedIndex >= 0)
    assert.equal(ordinary[allowedIndex + 1], claudeAllowedBridgeTools(false))
    assert.deepEqual(ordinary.slice(-3), ['--disallowedTools', 'Task', 'Agent'])

    // 仍然以真实运行时的角色判定为准：Team 会话换成 agent_team，联网工具保留。
    setSubagentBridge(teamRuntime(true))
    assert.equal(claudeBridgeArgs('s1', 'claude-code').at(-4), claudeAllowedBridgeTools(true))
  } finally {
    setSubagentBridge(undefined)
  }

  const guidance = `${bridgeSearchGuidance('mcp__codingns__web_search')} ${bridgeFetchGuidance('mcp__codingns__web_fetch')}`
  assert.match(guidance, /retry the same call once/u)
  assert.match(guidance, /WEB_PROVIDER_CREDENTIAL_MISSING/u)
  assert.match(guidance, /do not claim the search service is unavailable/u)
  assert.match(guidance, /Never report web search or web fetch as unavailable/u)

  // API key 与账号登录是两个并存的提供者：密钥被拒不能被描述成“接口不可用”，
  // 也不能让模型误以为登录账号就必须放弃 API key。
  assert.match(guidance, /two DeepSeek web providers at the same time/u)
  assert.match(guidance, /DEEPSEEK_API_KEY/u)
  assert.match(guidance, /account sign-in route/u)
  assert.match(guidance, /is invalid.*means that API key is no longer valid/su)
  assert.match(guidance, /replace the DeepSeek API key, or sign in to a DeepSeek account/u)
  assert.match(guidance, /billing to the account route/u)
  // 提示词里不得出现“登录后就不再使用 API key”这类二选一表述。
  assert.doesNotMatch(guidance, /instead of the API key|will not fall back/iu)
})

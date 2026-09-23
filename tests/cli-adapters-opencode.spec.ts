import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { OpenCodeDriver } from '../dist/host/cli-adapters/opencode-driver.js'

test('OpenCode 驱动探测本地 server 并读取模型目录', async () => {
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 })
    if (url.endsWith('/config/providers')) return new Response(JSON.stringify({ providers: { anthropic: { models: { sonnet: { name: 'Sonnet' } } } } }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  assert.deepEqual(await driver.detect(), { installed: true, version: '1.2.3', command: 'http://opencode.test' })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'anthropic', name: 'anthropic', models: [{ id: 'anthropic/sonnet', name: 'Sonnet', efforts: [] }] }],
    currentModel: null,
    currentEffort: null,
  })
})

test('OpenCode 模型目录保留 variants 思维强度并兼容 providers 数组', async () => {
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/config/providers')) return new Response(JSON.stringify({ providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5.5': { variants: { low: {}, high: {}, none: {} } } } }] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'openai/gpt-5.5', name: 'gpt-5.5', efforts: ['low', 'high', 'off'] }] }],
    currentModel: null,
    currentEffort: null,
  })
})

test('OpenCode SSE 事件转换为标准文本流并绑定远端会话', async () => {
  const encoder = new TextEncoder()
  const requests: unknown[] = []
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'remote-1' }), { status: 200 })
    if (url.endsWith('/message')) {
      requests.push(JSON.parse(String(init.body)))
      return new Response('{}', { status: 200 })
    }
    if (url.endsWith('/event')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('event: message.part.updated\ndata: {"properties":{"part":{"id":"p","type":"text","text":"结果"}}}\n\n'))
        controller.enqueue(encoder.encode('event: message.part.updated\ndata: {"properties":{"part":{"id":"tool-part","type":"tool","tool":"shell","callID":"open-call-1","state":{"status":"running","input":{"command":"pwd"}}}}}\n\n'))
        controller.enqueue(encoder.encode('event: message.part.updated\ndata: {"properties":{"part":{"id":"tool-part","type":"tool","tool":"shell","callID":"open-call-1","state":{"status":"completed","output":"/workspace"}}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"session.status","status":"idle"}\n\n'))
        controller.close()
      } })
      return new Response(body, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好', modelId: 'openai/gpt-5.5', effortId: 'high' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'remote-1' },
    { type: 'text-delta', text: '结果' },
    { type: 'tool-event', toolName: 'shell', callId: 'open-call-1', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-event', toolName: 'shell', callId: 'open-call-1', output: '/workspace', outputMode: 'snapshot', status: 'completed' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(requests, [{ parts: [{ type: 'text', text: '你好' }], model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: 'high' }])
})

test('OpenCode 创建会话和事件流都携带当前工作目录', async () => {
  const requests: string[] = []
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    requests.push(url)
    if (url.includes('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/session?directory=%2Fworkspace%2Fproject') && init.method === 'POST') return new Response(JSON.stringify({ id: 'remote-cwd' }), { status: 200 })
    if (url.endsWith('/message?directory=%2Fworkspace%2Fproject')) return new Response('{}', { status: 200 })
    if (url.endsWith('/event?directory=%2Fworkspace%2Fproject')) {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"session.status","status":"idle"}\n\n'))
        controller.close()
      } })
      return new Response(body, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 's-cwd', messages: [], prompt: '测试目录', cwd: '/workspace/project' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'remote-cwd' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.ok(requests.some((url) => url.endsWith('/session?directory=%2Fworkspace%2Fproject')))
  assert.ok(requests.some((url) => url.endsWith('/message?directory=%2Fworkspace%2Fproject')))
  assert.ok(requests.some((url) => url.endsWith('/event?directory=%2Fworkspace%2Fproject')))
})

test('OpenCode 只投影 assistant 消息，并优先使用事件 delta', async () => {
  const encoder = new TextEncoder()
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'remote-filter' }), { status: 200 })
    if (url.endsWith('/message')) return new Response('{}', { status: 200 })
    if (url.endsWith('/event')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message.part.updated","properties":{"part":{"id":"user-part","messageID":"user-message","type":"text","text":"用户提示"}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.updated","properties":{"info":{"id":"user-message","role":"user"}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"session.status","properties":{"sessionID":"other-session","status":"idle"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.part.delta","properties":{"messageID":"assistant-message","partID":"reasoning-part","field":"reasoning","delta":"先检查目录"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.part.delta","properties":{"messageID":"assistant-message","partID":"assistant-part","field":"text","delta":"The"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.updated","properties":{"info":{"id":"assistant-message","role":"assistant"}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.part.updated","properties":{"part":{"id":"reasoning-part","messageID":"assistant-message","type":"reasoning","text":"先检查目录"}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.part.delta","properties":{"messageID":"assistant-message","partID":"assistant-part","field":"text","delta":" answer"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message.part.updated","properties":{"part":{"id":"assistant-part","messageID":"assistant-message","type":"text","text":"The answer"}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"session.status","status":"idle"}\n\n'))
        controller.close()
      } })
      return new Response(body, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 's-filter', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'remote-filter' },
    { type: 'reasoning-delta', text: '先检查目录' },
    { type: 'text-delta', text: 'The' },
    { type: 'text-delta', text: ' answer' },
    { type: 'finish', reason: 'stop' },
  ])
})

test('OpenCode message 请求失败时立即结束 SSE 等待并返回错误', async () => {
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'remote-failed' }), { status: 200 })
    if (url.endsWith('/message')) return new Response('invalid model', { status: 400 })
    if (url.endsWith('/event')) {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  const iterator = driver.executeTurn({ sessionId: 's-failed', messages: [], prompt: '你好', modelId: 'openai/gpt-5.5' })[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'session-binding', providerSessionId: 'remote-failed' } })
  await assert.rejects(iterator.next(), /OpenCode message 请求失败（HTTP 400）/u)
})

test('OpenCode 把权限和问题 SSE 转成公共交互事件并回复原生接口', async () => {
  const encoder = new TextEncoder()
  const replies: Array<{ url: string; body: unknown }> = []
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
    if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'remote-interaction' }), { status: 200 })
    if (url.endsWith('/message')) return new Response('{}', { status: 200 })
    if (url.includes('/reply')) {
      replies.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 200 })
    }
    if (url.endsWith('/event')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"permission.asked","properties":{"id":"permission-1","sessionID":"remote-interaction","permission":"edit","patterns":["src/a.ts"]}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"question.asked","properties":{"id":"question-1","sessionID":"remote-interaction","questions":[{"question":"选择框架","header":"框架","options":[{"label":"React"},{"label":"Vue"}]}]}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"session.status","properties":{"status":{"type":"idle"}}}\n\n'))
        controller.close()
      } })
      return new Response(body, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'opencode-interaction', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') {
      await driver.respondPermission('opencode-interaction', { requestId: chunk.requestId, approved: true })
    }
    if (chunk.type === 'question-request') {
      await driver.respondQuestion('opencode-interaction', {
        requestId: chunk.requestId,
        answers: [{ id: 'question-1', selected: ['React'] }],
      })
    }
  }

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'remote-interaction' },
    { type: 'permission-request', requestId: 'permission-1', kind: 'edit', toolName: 'edit', detail: '["src/a.ts"]' },
    {
      type: 'question-request',
      requestId: 'question-1',
      questions: [{ id: 'question-1', question: '选择框架', header: '框架', options: [{ label: 'React' }, { label: 'Vue' }] }],
    },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(replies, [
    { url: 'http://opencode.test/permission/permission-1/reply', body: { reply: 'once' } },
    { url: 'http://opencode.test/question/question-1/reply', body: { answers: [['React']] } },
  ])
})

test('OpenCode 未发现外部服务时按工作区托管 serve，并在 dispose 时只回收自有进程', async () => {
  let spawned = false
  let killed = false
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/global/health') && spawned) return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })
    return new Response('{}', { status: 503 })
  }
  const driver = new OpenCodeDriver({
    fetch,
    serverUrls: ['http://external-opencode.test'],
    binaries: ['opencode'],
    spawnSync: (() => ({ status: 0, stdout: 'opencode 2.0.0', stderr: '' })) as never,
    spawn: (() => {
      spawned = true
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return { stdout, stderr, kill() { killed = true; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog, { groups: [], currentModel: null, currentEffort: null })
  driver.dispose()
  assert.equal(spawned, true)
  assert.equal(killed, true)
})

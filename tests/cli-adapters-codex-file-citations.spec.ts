import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { CodexFileCitationNormalizer } from '../data/build/dist/host/cli-adapters/codex-file-citations.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

interface Notification {
  readonly method: string
  readonly params: Record<string, unknown>
}

const delta = (text: string, itemId = 'message-1'): Notification => ({
  method: 'item/agentMessage/delta', params: { itemId, delta: text },
})

/** 通过真实驱动消费 app-server 通知，覆盖普通回合和 DSH 续段。 */
async function collect(notifications: readonly Notification[], segmented: boolean, status = 'completed') {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.160.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`)
      const stdin = { write(data: string) {
        const request = JSON.parse(data)
        if (request.id === undefined) return
        const result = request.method === 'thread/start' ? { thread: { id: 'thread-1' } }
          : request.method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress' } } : {}
        send({ jsonrpc: '2.0', id: request.id, result })
        if (request.method !== 'turn/start') return
        for (const notification of notifications) send({
          jsonrpc: '2.0', ...notification,
          params: { threadId: 'thread-1', turnId: 'turn-1', ...notification.params },
        })
        send({ jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: 'thread-1', turn: { id: 'turn-1', status },
        } })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const events: CodingNsAgentEvent[] = []
  try {
    let resumeSegmentedTurn = false
    do {
      for await (const event of driver.executeTurn({
        sessionId: 'citation-session', cwd: 'C:\\repo', messages: [], prompt: '生成文件',
        splitToolSteps: segmented, resumeSegmentedTurn,
      })) events.push(event)
      resumeSegmentedTurn = events.at(-1)?.type === 'step-boundary'
    } while (resumeSegmentedTurn)
    return events
  } finally { driver.dispose() }
}

function body(events: readonly CodingNsAgentEvent[]): string {
  return events.filter((event) => event.type === 'text-delta').map((event) => event.text).join('')
}

function links(text: string) {
  const result: Array<{ url: string; title?: string | null; label: string }> = []
  const visit = (node: ReturnType<typeof fromMarkdown>['children'][number]) => {
    if (node.type === 'link') result.push({
      url: node.url, title: node.title,
      label: node.children.map((child) => child.type === 'text' ? child.value : '').join(''),
    })
    if ('children' in node) for (const child of node.children) visit(child as typeof node)
  }
  for (const node of fromMarkdown(text).children) visit(node)
  return result
}

test('Codex 正文立即输出确定的前缀，链接在闭合后输出而无需等待 finish', () => {
  const normalizer = new CodexFileCitationNormalizer()
  assert.equal(body([...normalizer.push({ type: 'text-delta', text: '普通正文 [备注] 后文 ' })]), '普通正文 [备注] 后文 ')
  assert.equal(body([...normalizer.push({ type: 'text-delta', text: '[名称](D:/目录/文件.ts:12' })]), '')
  assert.equal(body([...normalizer.push({ type: 'text-delta', text: '64) 结束' })]), '[名称](D:/目录/文件.ts#L1264) 结束')
  assert.deepEqual([...normalizer.flush()], [])
})

for (const segmented of [false, true]) {
  const mode = segmented ? '分段' : '普通'
  test(`Codex ${mode}仅转换 Markdown 文件链接目标的行号，保留标签与标题`, async () => {
    const text = [
      '[名称](D:/目录/文件.ts:1264)',
      '[反斜杠](D:\\repo\\file.ts:27)',
      '[Unix](/repo/file.ts:3)',
      '[相对](src/file.ts:42 "标题:123")',
      '[文件](file.ts:5)',
      '[空格](<D:/目录/文件 (最终).ts:6> "说明")',
      '[**标签** `:99`](../src/file(1).ts:7)',
      '[目标前空白](  src/file.ts:8  "标题")',
    ].join('\n')
    const expected = text.replace(/:1264\)/u, '#L1264)').replace(/:27\)/u, '#L27)')
      .replace(/:3\)/u, '#L3)').replace(/:42 /u, '#L42 ').replace(/:5\)/u, '#L5)')
      .replace(/:6>/u, '#L6>').replace(/:7\)/u, '#L7)')
      .replace(/:8 /u, '#L8 ')
    const events = await collect([delta(text)], segmented)
    assert.equal(body(events), expected)
    assert.ok(links(body(events))[0]?.url.endsWith('/文件.ts#L1264'))
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  })

  test(`Codex ${mode}文件链接兼容每个分片切点及逐字符流`, async () => {
    const text = '前文 [名称](D:/目录/文件.ts:1264 "标题") 后文'
    const expected = text.replace('文件.ts:1264', '文件.ts#L1264')
    for (let index = 1; index < text.length; index += 1) {
      assert.equal(body(await collect([delta(text.slice(0, index)), delta(text.slice(index))], segmented)), expected, `切点 ${index}`)
    }
    const events = await collect([...text].map((character) => delta(character)), segmented)
    assert.equal(body(events), expected)
    assert.ok(events.filter((event) => event.type === 'text-delta').every((event) => event.messageId === 'message-1'))
  })

  test(`Codex ${mode}保留盘符、URL、正文、代码和非文本事件`, async () => {
    const text = [
      '正文 D:/目录/文件.ts:1264 与 src/file.ts:42、孤立 ](src/file.ts:42)。',
      '[盘符](D:) [裸盘符行号](D:1264)',
      '[URL](https://example.test/file.ts:1264) [端口](http://localhost:3000)',
      '[无协议 URL](//example.test:8080) [文件 URL](file:///D:/file.ts:12)',
      '[自定义](vscode://file/D:/file.ts:12) [邮件](mailto:user.ts:12)',
      '[已有片段](src/file.ts#L12) [查询](src/file.ts?x=:12)',
      '[零](src/file.ts:0) [列](src/file.ts:12:3)',
      '![图片](src/file.ts:42) \\[转义](src/file.ts:42)',
      '`[行内](src/file.ts:42)` ``[代码 `](src/file.ts:42)``',
      '```ts', '[围栏](D:/目录/文件.ts:1264)', '```',
      '~~~markdown', '[波浪围栏](src/file.ts:42)', '~~~',
      '', '    [缩进](src/file.ts:42)', '\t[制表符](src/file.ts:42)', '',
      '> ```', '> [引用代码](src/file.ts:42)', '> ```',
      '', '[真正链接](src/file.ts:42)',
    ].join('\n')
    const notifications = [...text].map((character) => delta(character))
    notifications.splice(20, 0, { method: 'item/reasoning/textDelta', params: { itemId: 'reason-1', delta: '[推理](src/file.ts:42)' } })
    const events = await collect(notifications, segmented)
    assert.equal(body(events), text.replace('[真正链接](src/file.ts:42)', '[真正链接](src/file.ts#L42)'))
    assert.ok(events.some((event) => event.type === 'reasoning-delta' && event.text === '[推理](src/file.ts:42)'))
  })

  test(`Codex ${mode}跨行代码及分片围栏不能改写其中的文件链接`, async () => {
    const text = [
      '前文 `未结束代码', '[跨行](src/file.ts:42)', '代码结束` 后文',
      '', '   ````md', '[更长围栏](src/file.ts:42)', '```', '[仍是代码](src/file.ts:42)', '````',
      '', '[正文](src/file.ts:42)',
    ].join('\n')
    assert.equal(body(await collect([...text].map((character) => delta(character)), segmented)), text.replace('[正文](src/file.ts:42)', '[正文](src/file.ts#L42)'))
  })

  test(`Codex ${mode}消息及工具边界原样结算残缺链接，不拼接到下条消息`, async () => {
    const first = '前文 [名称](D:/目录/文件.ts:12'
    const second = '64) [下一条](src/file.ts:42)'
    const events = await collect([
      delta(first),
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'link-tool', command: 'pwd', aggregatedOutput: '[工具输出](src/file.ts:42)', exitCode: 0 } } },
      delta(second, 'message-2'),
    ], segmented)
    const toolIndex = events.findIndex((event) => event.type === 'tool-event')
    assert.equal(body(events.slice(0, toolIndex)), first)
    assert.equal(body(events), first + second.replace('file.ts:42', 'file.ts#L42'))
    assert.equal(events.some((event) => event.type === 'step-boundary'), segmented)
    const messagesOnly = await collect([delta(first), delta(second, 'message-2')], segmented)
    assert.equal(body(messagesOnly.filter((event) => event.type === 'text-delta' && event.messageId === 'message-1')), first)
    assert.equal(body(messagesOnly), first + second.replace('file.ts:42', 'file.ts#L42'))
  })

  for (const status of ['completed', 'failed', 'interrupted']) {
    test(`Codex ${mode}${status}终态前结算不完整 Markdown，完整链接仍转换`, async () => {
      const text = '[完整](src/file.ts:42) 未闭合 [链接](D:/文件.ts:12'
      const events = await collect([...text].map((character) => delta(character)), segmented, status)
      assert.equal(body(events), text.replace('file.ts:42', 'file.ts#L42'))
      assert.equal(events.at(-1)?.type, 'finish')
    })
  }

  test(`Codex ${mode}正文将 output/source 文件引用转换为 DSH 链接，保留正文与属性`, async () => {
    const output = ':codex-file-citation{path="/tmp/报告 (最终)#1.pdf" purpose="output"}'
    const source = ':codex-file-citation{purpose="source" path="C:\\repo\\src\\main.ts" line_start=12 line_end=18}'
    const events = await collect([delta(`已生成：${output}\n参考：${source}\n正文保留。`)], segmented)
    const text = body(events)
    const citations = links(text)
    assert.equal(citations.length, 2)
    assert.ok(text.startsWith('已生成：['))
    assert.ok(text.includes('\n参考：['))
    assert.ok(text.endsWith('\n正文保留。'))
    assert.deepEqual(citations.map((link) => decodeURIComponent(link.url)), [
      '/tmp/报告 (最终)#1.pdf', 'C:/repo/src/main.ts#L12-L18',
    ])
    assert.ok(citations[0]!.url.includes('%231.pdf'), '文件名中的 # 必须编码，不能作为行号片段')
    assert.ok(citations[1]!.url.endsWith('#L12-L18'), 'source 行号使用 DSH 支持的导航片段')
    assert.deepEqual(citations.map((link) => link.label), ['/tmp/报告 (最终)#1.pdf', 'C:\\repo\\src\\main.ts'])
    assert.equal(citations[0]?.title, output.slice(':codex-file-citation{'.length, -1))
    assert.equal(citations[1]?.title, source.slice(':codex-file-citation{'.length, -1))
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  })

  test(`Codex ${mode}逐字符流式分片与完整正文产生相同文件链接`, async () => {
    const text = '前文 :codex-file-citation{path="docs/说明 [v1] {草稿}.md" purpose="source"} 后文 :普通文本'
    const whole = await collect([delta(text)], segmented)
    const streamed = await collect([...text].map((character) => delta(character)), segmented)
    assert.equal(body(streamed), body(whole))
    assert.equal(links(body(streamed)).length, 1)
    assert.equal(links(body(streamed))[0]?.label, 'docs/说明 [v1] {草稿}.md')
    assert.equal(streamed.filter((event) => event.type === 'text-delta').every((event) => event.messageId === 'message-1'), true)
  })

  test(`Codex ${mode}保留 live、非文件 URI、未知用途与不完整引用原文`, async () => {
    const text = [
      ':codex-file-citation{mode="live" path="stream-1" purpose="source"}',
      ':codex-file-citation{path="https://example.test/a" purpose="output"}',
      ':codex-file-citation{path="report.md" purpose="unknown"}',
      ':codex-file-citation{purpose="source"}',
      '未闭合 :codex-file-citation{path="report.md" purpose="output"',
    ].join('\n')
    assert.equal(body(await collect([...text].map((character) => delta(character)), segmented)), text)
  })

  test(`Codex ${mode}Windows 路径不按 JSON 转义，特殊字符与附加引用信息保留`, async () => {
    const citation = ':codex-file-citation{path="C:\\new\\temp\\说明 &copy; [1]%?.md" purpose="output" label="交付文件"}'
    const events = await collect([delta(`冒号:普通前文 ${citation} 后文`)], segmented)
    const link = links(body(events))[0]!
    assert.equal(link.label, 'C:\\new\\temp\\说明 &copy; [1]%?.md')
    assert.equal(decodeURIComponent(link.url), 'C:/new/temp/说明 &copy; [1]%?.md')
    assert.ok(link.url.includes('%25%3F.md'))
    assert.equal(link.title, citation.slice(':codex-file-citation{'.length, -1))
    assert.ok(body(events).startsWith('冒号:普通前文 '))
    assert.ok(body(events).endsWith(' 后文'))
  })

  test(`Codex ${mode}消息边界不会将两条消息的残缺引用拼成文件链接`, async () => {
    const first = '第一条 :codex-file-citation{path="'
    const second = 'report.md" purpose="output"} 第二条'
    const events = await collect([delta(first), delta(second, 'message-2')], segmented)
    assert.equal(body(events), first + second)
    assert.equal(links(body(events)).length, 0)
    assert.equal(events.filter((event) => event.type === 'text-delta' && event.messageId === 'message-1').map((event) => event.text).join(''), first)
  })

  test(`Codex ${mode}工具及续段边界保留前文，下一条消息继续转换引用`, async () => {
    const first = '工具前 :codex-file-citation{path="unfinished'
    const events = await collect([
      delta(first),
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', aggregatedOutput: 'C:/repo', exitCode: 0 } } },
      ...[...'工具后 :codex-file-citation{path="/C:/repo/result.md" purpose="output"} 完成'].map((character) => delta(character, 'message-2')),
    ], segmented)
    assert.ok(body(events).startsWith(first + '工具后 '))
    assert.equal(links(body(events)).length, 1)
    assert.equal(links(body(events))[0]!.url, 'C:/repo/result.md')
    assert.equal(events.some((event) => event.type === 'step-boundary'), segmented)
    const toolIndex = events.findIndex((event) => event.type === 'tool-event')
    assert.equal(body(events.slice(0, toolIndex)), first)
  })

  for (const [status, reason] of [['failed', 'error'], ['interrupted', 'cancel']] as const) {
    test(`Codex ${mode}${reason}终态之前保留未闭合引用`, async () => {
      const text = '已写入 :codex-file-citation{path="result.md"'
      const events = await collect([delta(text)], segmented, status)
      assert.equal(body(events), text)
      assert.equal(events.at(-1)?.type, 'finish')
      assert.equal((events.at(-1) as Extract<CodingNsAgentEvent, { type: 'finish' }>).reason, reason)
    })
  }
}

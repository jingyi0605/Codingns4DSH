import assert from 'node:assert/strict'
import test from 'node:test'
import { DoubaoEventProjector } from '../src/host/cli-adapters/doubao-events.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'

const frame = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) })
const ack = () => frame('SSE_ACK', { ack_client_meta: { conversation_id: '101' } })
const patch = (block: unknown) => frame('STREAM_CHUNK', { message_id: '301', patch_op: [{ patch_value: { content_block: [block] } }] })
const tool = (id: string, type: number, content: unknown, finished = false, patchType = 1) => ({
  block_id: id, block_type: type, patch_type: patchType, is_finish: finished, content,
})
function projector() { const p = new DoubaoEventProjector('101'); p.accept(ack()); return p }

// 字段结构来自 macOS 豆包 2.12.8 实测；数据替换为合成样本，不保存私有会话或下载地址。
const search = () => tool('search', 10025, { search_query_result_block: {
  summary: '已搜索 2 个网页', queries: ['Python pathlib 官方文档'],
  results: [
    { text_card: { title: 'pathlib 官方文档', url: 'https://docs.python.org/3/library/pathlib.html', doc_id: '不落盘' } },
    { text_card: { title: '带签名的来源', url: 'https://example.com/?token=SECRET', search_id: '不落盘' } },
  ], icon_url: 'https://example.com/?token=SECRET',
} }, true)

test('豆包搜索块输出查询、来源与结果，去重且不泄露私有链接', () => {
  const p = projector()
  const events: any[] = p.accept(patch(search()))
  assert.equal(events.length, 1)
  assert.equal(events[0].toolName, '豆包联网搜索')
  assert.equal(events[0].status, 'completed')
  assert.deepEqual(JSON.parse(events[0].input).queries, ['Python pathlib 官方文档'])
  assert.match(events[0].output, /pathlib 官方文档/u)
  assert.match(events[0].output, /https:\/\/docs.python.org\/3\/library\/pathlib.html/u)
  assert.doesNotMatch(JSON.stringify(events), /SECRET|不落盘|icon_url/u)
  assert.deepEqual(p.accept(patch(search())), [])
})

test('豆包网页读取显示开始和结果，同一工具稳定绑定且正文不混入工具', () => {
  const p = projector()
  const start: any = p.accept(patch(tool('reader', 10006, { link_reader_block: {
    summary: '正在阅读内容: https://docs.python.org/3/', tool_name: 'web.fetch',
  } }, false, 2)))[0]
  const done: any = p.accept(patch(tool('reader', 10006, { link_reader_block: {
    summary: '已阅读内容', items: [{ title: 'Python 文档', url: 'https://docs.python.org/3/', summary: '官方说明' }],
  } }, true, 2)))[0]
  assert.equal(start.status, 'started'); assert.equal(done.status, 'completed')
  assert.equal(start.callId, done.callId)
  assert.equal(start.toolName, '豆包网页读取')
  assert.match(start.input, /正在阅读/u); assert.match(done.output, /官方说明/u)
})

test('豆包加载状态增量和替换可见，重复快照不刷屏，删除未完成块不伪报成功', () => {
  const p = projector()
  const loading = (text: string, finished = false) => patch(tool('loading', 10101, { loading_block: { text_loading: { text } } }, finished, 2))
  assert.equal((p.accept(loading('正在搜索'))[0] as any).status, 'started')
  assert.deepEqual(p.accept(loading('正在搜索')), [])
  assert.match((p.accept(loading('找到相关网页'))[0] as any).output, /找到相关网页/u)
  const removed: any = p.accept(patch({ block_id: 'loading', patch_type: 3 }))[0]
  assert.equal(removed.status, 'failed'); assert.match(removed.error, /撤回/u)
  assert.deepEqual(p.accept(patch({ block_id: 'loading', patch_type: 3 })), [])
})

test('豆包云端操作保留标题及执行输出，普通代码块不冒充已执行工具', () => {
  const p = projector()
  p.accept(patch(tool('operation', 10019, { file_operation_block: { header: { summary: '计算平方和任务' }, operation_type: 1 } }, false, 2)))
  const done: any = p.accept(patch(tool('operation', 10019, { file_operation_block: {
    content: 'python3 -c "print(42)"\nExit code 0\n42', uri: '/private/SECRET', file_type: 'text',
  } }, true)))[0]
  assert.match(done.output, /计算平方和任务/u)
  assert.match(done.output, /Exit code 0\n42/u)
  assert.doesNotMatch(JSON.stringify(done), /SECRET/u)
  assert.deepEqual(p.accept(patch(tool('snippet', 10008, { code_block: { code: 'print(42)' } }, true))), [])
})

test('豆包通用工具失败与产物元数据可见，不猜测数字状态含义', () => {
  const p = projector()
  const failed: any = p.accept(patch(tool('generic', 10024, { generic_tool_block: {
    tool_name: '云端转换', title: '转换报告', summary: '格式不支持', status: 'failed',
  } }, true)))[0]
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /格式不支持/u)
  const file: any = p.accept(patch(tool('file', 10020, { file_block: {
    name: 'report.txt', type: 'txt', size: '42', url: 'https://example.com/?signature=SECRET',
  } }, true)))[0]
  assert.equal(JSON.parse(file.input).file, 'report.txt')
  assert.match(file.output, /42/); assert.match(file.output, /豆包会话/u)
  assert.doesNotMatch(JSON.stringify(file), /SECRET/u)
  const numeric: any = p.accept(patch(tool('numeric', 10024, { generic_tool_block: { title: '数值状态', status: 5 } })))[0]
  assert.equal(numeric.status, 'started')
})

test('豆包工具替换清除旧结果，长输出有上限且未知字段不进入历史', () => {
  const p = projector()
  p.accept(patch(tool('reader', 10006, { link_reader_block: { items: [{ title: '旧结果' }] } })))
  const done: any = p.accept(patch(tool('reader', 10006, { link_reader_block: {
    summary: '新结果', description: 'x'.repeat(100_000), credentials: { token: 'SECRET' },
  } }, true, 2)))[0]
  assert.doesNotMatch(done.output, /旧结果|SECRET/u)
  assert.ok(done.output.length < 20_000)
  assert.match(done.output, /截断/u)
})

test('豆包云端输出追加后可被快照替换，独立结束标记保留最终内容', () => {
  const p = projector()
  p.accept(patch(tool('operation', 10019, { file_operation_block: { content: '第一段\n' } })))
  const second: any = p.accept(patch(tool('operation', 10019, { file_operation_block: { content: '第二段' } })))[0]
  assert.equal(second.output, '第一段\n第二段')
  p.accept(patch(tool('operation', 10019, { file_operation_block: { content: '替换结果' } }, false, 2)))
  const done: any = p.accept(patch({ block_id: 'operation', is_finish: true }))[0]
  assert.equal(done.output, '替换结果'); assert.equal(done.status, 'completed')
})

test('豆包搜索经公共投影和原生桥生成工具声明、调用和结果，正文独立', async () => {
  const events: any[] = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }]
  const session = { header: { version: 4 }, snapshotEvents: () => [...events], append(type: string, data: unknown) {
    const event = { type, seq: events.length, data }; events.push(event); return event
  } }
  const nativeSessions = createCodingNsNativeSessionBridge({ get(name: string) {
    return name === 'sessions' ? { get: () => session, list: () => [session] } : undefined
  } } as never)
  const dsh = new CodingNsDshMessageProjector({ sessionId: 'test', adapterId: 'doubao', nativeSessions })
  for (const event of projector().accept(patch(search()))) assert.deepEqual(await dsh.push(event), [])
  const body = await dsh.push({ type: 'text-delta', text: '检索后的回答' })
  await dsh.push({ type: 'finish', reason: 'stop' })
  assert.deepEqual(events.slice(2).map(e => e.type), ['assistant/message', 'tool/call', 'tool/result'])
  assert.equal(events[3].data.name, '豆包联网搜索')
  assert.match(events[3].data.arguments, /Python pathlib/u)
  assert.match(events[4].data.message.content[0].text, /pathlib 官方文档/u)
  assert.ok(body.some(c => c.type === 'text-delta' && c.text === '检索后的回答'))
})

test('豆包工具无原生桥时发送可显示标记', async () => {
  const dsh = new CodingNsDshMessageProjector({ sessionId: 'test', adapterId: 'doubao' })
  const events = projector().accept(patch(search()))
  const chunks = await dsh.push(events[0]!)
  const marker: any = chunks.find(c => c.codingnsExternalTool)?.codingnsExternalTool
  assert.equal(marker.name, '豆包联网搜索'); assert.equal(marker.status, 'completed')
  assert.match(marker.output, /pathlib 官方文档/u)
  await dsh.complete()
})

test('豆包未完成工具在取消或流失败后写入失败终态，不留运行中卡片', async () => {
  for (const reason of ['cancel', 'error'] as const) {
    const results: any[] = []
    const dsh = new CodingNsDshMessageProjector({ sessionId: 'test', adapterId: 'doubao', nativeSessions: {
      appendToolCall: () => ({ sessionId: 'test', turn: 1, step: 1, callId: 'reader', callSeq: 1 }),
      appendToolResult: (_handle: unknown, result: unknown) => { results.push(result); return true },
    } as never })
    const pending = projector().accept(patch(tool('reader', 10006, { link_reader_block: { summary: '正在阅读' } })))
    for (const event of pending) await dsh.push(event)
    await dsh.push({ type: 'finish', reason })
    assert.equal(results.length, 1)
    assert.equal(results[0].isError, true)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { captureTerminalSnapshot, createTerminalSnapshot, encodeTerminalSnapshot, decodeTerminalSnapshot, formatTerminalSnapshot, TERMINAL_SHARE_MAX_BYTES } from '../data/build/dist/client/terminal/snapshot.js'
import { TerminalSharing } from '../data/build/dist/client/terminal/sharing.js'
import { createTerminalSharingBridge, readTerminalShareTargets, selectRecentTerminalShareTargets, supportsTerminalSharing } from '../data/build/dist/dsh-capabilities/client/terminal-sharing-adapter.js'
import { installTerminalSelectionActions, positionTerminalSelectionActions } from '../data/build/dist/client/terminal/selection-actions.js'
import { createDshCapabilityRegistry } from '../data/build/dist/dsh-capabilities/routes.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/contracts/peer-host.js'
import type { CodingNsTerminalView } from '../data/build/dist/client/terminal/model.js'
import { en as terminalEn } from '../data/build/dist/client/locales/terminalAuth.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import { TerminalLogPreviewContent } from '../data/build/dist/client/terminal/log-preview.js'

const source = { terminalId: 'terminal-1', title: '测试终端', sourceHostId: 'local', sourceWorkspaceId: 'workspace-1', cwd: '/代码', shell: 'zsh' }
const timestamp = '2026-10-07T02:00:00.000Z'

function reader(rows: readonly { text: string; wrapped?: boolean }[], selection = '', type: 'normal' | 'alternate' = 'normal') {
  return { getSelection: () => selection, rows: 2, buffer: { active: {
    type, length: rows.length, viewportY: Math.max(0, rows.length - 2),
    getLine: (index: number) => rows[index] === undefined ? undefined : {
      isWrapped: rows[index]!.wrapped === true,
      translateToString: (trimRight?: boolean) => trimRight ? rows[index]!.text.trimEnd() : rows[index]!.text,
    },
  } } }
}

test('快照保留中文和软换行前的空格，去掉末尾屏幕空行', () => {
  const snapshot = captureTerminalSnapshot(reader([
    { text: '编译失败：  ' }, { text: '缺少依赖', wrapped: true }, { text: '第二行  ' }, { text: '' },
  ], '选中的日志'), source, undefined, timestamp)
  assert.equal(snapshot.range, 'recent')
  assert.equal(snapshot.text, '编译失败：  缺少依赖\n第二行')
  assert.equal(snapshot.capturedAt, timestamp)
  assert.ok(Object.isFrozen(snapshot))
})

test('备用屏幕只有当前屏幕与显式选区，没有伪造的最近历史', () => {
  const terminal = reader([{ text: '编辑器界面' }], '', 'alternate')
  const screen = captureTerminalSnapshot(terminal, source, undefined, timestamp)
  assert.equal(screen.range, 'screen')
  assert.equal(screen.text, '编辑器界面')
  const selection = captureTerminalSnapshot(terminal, source, '界面', timestamp)
  assert.equal(selection.range, 'selection')
  assert.equal(selection.text, '界面')
})

test('打开分享后终端继续输出，已冻结的范围不随画面改变', () => {
  const rows = [{ text: '旧日志' }]
  const snapshot = captureTerminalSnapshot(reader(rows), source, undefined, timestamp)
  rows[0]!.text = '新日志'
  rows.push({ text: '继续输出' })
  assert.equal(snapshot.text, '旧日志')
})

test('工具栏始终取最近 200 行，选区入口只取传入的选中文本', () => {
  const rows = Array.from({ length: 230 }, (_item, index) => ({ text: `第${index}行` }))
  const terminal = reader(rows, '终端当前选区')
  const recent = captureTerminalSnapshot(terminal, source, undefined, timestamp)
  assert.equal(recent.range, 'recent')
  assert.equal(recent.lineCount, 200)
  assert.equal(recent.text.split('\n')[0], '第30行')
  const selected = captureTerminalSnapshot(terminal, source, '点击前冻结的选区', timestamp)
  assert.equal(selected.range, 'selection')
  assert.equal(selected.text, '点击前冻结的选区')
})

test('最近输出保留最后 200 行，选区保留开头并报告截断', () => {
  const raw = Array.from({ length: 220 }, (_item, index) => `第${index}行`).join('\n')
  const recent = createTerminalSnapshot(source, 'recent', raw, timestamp)
  const selection = createTerminalSnapshot(source, 'selection', raw, timestamp)
  assert.equal(recent.lineCount, 200)
  assert.equal(recent.originalLineCount, 220)
  assert.equal(recent.text.split('\n')[0], '第20行')
  assert.equal(selection.text.split('\n').at(-1), '第199行')
  assert.ok(recent.truncated && selection.truncated)
})

test('UTF-8 限制不会拆开中文与 emoji，首尾两种截取均可恢复', () => {
  const raw = '中🙂'.repeat(10000)
  for (const range of ['selection', 'recent'] as const) {
    const snapshot = createTerminalSnapshot(source, range, raw, timestamp)
    assert.ok(Buffer.byteLength(snapshot.text) <= TERMINAL_SHARE_MAX_BYTES)
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(snapshot.text)), snapshot.text)
    assert.doesNotMatch(snapshot.text, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u)
    assert.deepEqual(decodeTerminalSnapshot(encodeTerminalSnapshot(snapshot)), snapshot)
  }
})

test('固定快照随原生引用 JSON 保存，刷新后不依赖原终端或缓存', () => {
  const original = createTerminalSnapshot(source, 'selection', 'Error: 测试失败\n```危险的围栏```', timestamp)
  const reference = { source: 'codingns-terminal-log', ref: encodeTerminalSnapshot(original), clipboardText: formatTerminalSnapshot(original) }
  const restored = JSON.parse(JSON.stringify({ references: [reference] })).references[0]
  assert.equal(formatTerminalSnapshot(decodeTerminalSnapshot(restored.ref)), restored.clipboardText)
  assert.match(restored.clipboardText, /````text/u)
  assert.throws(() => decodeTerminalSnapshot(JSON.stringify({ ...original, text: 'a'.repeat(40000) })))
  assert.throws(() => decodeTerminalSnapshot(JSON.stringify({ ...original, lineCount: 999 })))
})

test('分享正文元信息支持语言词典，日志原文不参与翻译', () => {
  const t = (key: string, args: Record<string, unknown> = {}) => (terminalEn[key] ?? key)
    .replace(/\{(\w+)\}/gu, (_match, name: string) => String(args[name]))
  const snapshot = createTerminalSnapshot(source, 'recent', '原始错误不能翻译', timestamp)
  const output = formatTerminalSnapshot(snapshot, t)
  assert.match(output, /Terminal log snapshot/u)
  assert.match(output, /Launch directory: \/代码/u)
  assert.match(output, /原始错误不能翻译/u)
})

function fixture(options: { reference?: boolean; locked?: boolean; stale?: boolean } = {}) {
  const calls = { navigation: [] as string[], text: [] as string[], references: [] as unknown[], referenceSessions: [] as string[], created: [] as { workspaceId: string }[], persisted: 0, focused: 0, submitted: 0 }
  const inputs = new Map(['source-session', 'target-session'].map((id) => [id, {
    draft: id === 'target-session' ? '请帮我分析现有问题' : '源会话草稿',
    attachments: ['已有附件'], phase: options.locked ? 'submitting' : 'plain', draftRev: 7,
  }]))
  const registry = new Map<string, any>()
  const inputFor = (id: string) => {
    const state = inputs.get(id)!
    return {
      state: { getSnapshot: () => state },
      actions: {
        captureInsertion: () => ({ start: 2, end: state.draft.length, draftRev: options.stale ? 6 : state.draftRev }),
        insertText: (text: string, span: { start: number; end: number; draftRev: number }) => {
          if (span.draftRev !== state.draftRev) return false
          assert.equal(span.start, span.end, '不能替换已有选区')
          state.draft += text
          calls.text.push(text)
          return true
        },
        persistDraft: () => { calls.persisted += 1 },
      },
      ...(options.reference === false ? {} : { insertReference: (reference: unknown, span: { start: number; end: number; draftRev: number }) => {
        if (span.draftRev !== state.draftRev) return false
        assert.equal(span.start, span.end)
        calls.references.push(reference)
        calls.referenceSessions.push(id)
        return true
      } }),
      focus: () => { calls.focused += 1 }, submit: () => { calls.submitted += 1 },
    }
  }
  const workspace = { workspaceId: 'workspace-1', title: '测试工作区', sessionIds: [...inputs.keys()] }
  const services: Record<string, unknown> = {
    sessions: {
      scope: (id: string) => inputs.has(id) ? { sessionId: id } : undefined,
      list: { getSnapshot: () => ({ byId: {} }) },
      create: async (request: { workspaceId: string }) => {
        calls.created.push(request)
        const id = `new-session-${calls.created.length}`
        inputs.set(id, { draft: '', attachments: [], phase: 'plain', draftRev: 0 })
        workspace.sessionIds.push(id)
        return id
      },
    },
    conversation: { input: { for: (scope: { sessionId: string }) => inputFor(scope.sessionId) } },
    uiWorkspace: { openSession: (id: string) => { calls.navigation.push(id) } },
    workspaces: { list: { getSnapshot: () => ({ items: [workspace], archivedSessionIds: [] }) } },
    'remote.session': { list: async () => ({ ok: true, value: { items: [...inputs.keys()].map((sessionId) => ({ sessionId, projections: { values: { title: sessionId } } })) } }) },
    inputTriggers: { registerSource: (item: any) => { registry.set(item.name, item); return () => registry.delete(item.name) } },
  }
  return { calls, inputs, registry, services, context: { get: (name: string) => services[name] } }
}

test('指定目标草稿插入保留源草稿和附件，不自动提交消息', async () => {
  const fake = fixture()
  const bridge = createTerminalSharingBridge(fake.context)
  await bridge.insert('target-session', 'Error: failed')
  assert.equal(fake.inputs.get('source-session')?.draft, '源会话草稿')
  assert.match(fake.inputs.get('target-session')!.draft, /^请帮我分析现有问题/u)
  assert.deepEqual(fake.inputs.get('target-session')?.attachments, ['已有附件'])
  assert.deepEqual(fake.calls.navigation, ['target-session'])
  assert.equal(fake.calls.persisted, 1)
  assert.equal(fake.calls.focused, 1)
  assert.equal(fake.calls.submitted, 0)
})

test('新建会话在当前工作区创建新身份，再将固定日志卡片加入新草稿', async () => {
  const fake = fixture()
  const sessions = fake.services.sessions as { list: { getSnapshot(): unknown } }
  sessions.list = { getSnapshot: () => ({ byId: Object.fromEntries([...fake.inputs.keys()].map((id) =>
    [id, { blank: id === 'source-session' || id.startsWith('new-session-') }])) }) }
  const bridge = createTerminalSharingBridge(fake.context)
  const sharing = new TerminalSharing()
  sharing.attachBridge(bridge)
  sharing.attachReferences()
  const snapshot = createTerminalSnapshot(source, 'selection', '选中的失败日志', timestamp)
  await sharing.shareToNew(snapshot, 'source-session', '日志引用')
  assert.deepEqual(fake.calls.created, [{ workspaceId: 'workspace-1' }])
  assert.deepEqual(fake.calls.navigation, ['new-session-1'])
  assert.deepEqual(fake.calls.referenceSessions, ['new-session-1'])
  const reference = fake.calls.references[0] as { ref: string }
  assert.equal(decodeTerminalSnapshot(reference.ref).text, '选中的失败日志')
  assert.equal(fake.inputs.get('source-session')?.draft, '源会话草稿')
  assert.deepEqual(fake.inputs.get('source-session')?.attachments, ['已有附件'])
  assert.equal(fake.inputs.get('target-session')?.draft, '请帮我分析现有问题')
  assert.equal(fake.calls.persisted, 1)
  assert.equal(fake.calls.submitted, 0)
  assert.deepEqual((await bridge.targets(undefined, { sessionId: 'source-session', limit: 5 })).map((item) => item.sessionId), ['target-session'])
  sharing.dispose()
})

test('新会话插入失败后重试复用已经创建的目标，不重复创建空白会话', async () => {
  const options = { stale: true }
  const fake = fixture(options)
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  const snapshot = createTerminalSnapshot(source, 'recent', '失败日志', timestamp)
  await assert.rejects(sharing.shareToNew(snapshot, 'source-session', '日志引用'), /草稿已变化/u)
  options.stale = false
  await sharing.shareToNew(snapshot, 'source-session', '日志引用')
  assert.equal(fake.calls.created.length, 1)
  assert.deepEqual(fake.calls.referenceSessions, ['new-session-1'])
  assert.equal(fake.calls.submitted, 0)
  sharing.dispose()
})

test('创建失败可重试；引用未就绪、工作区丢失或返回旧身份时不写已有草稿', async () => {
  const fake = fixture()
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  const snapshot = createTerminalSnapshot(source, 'recent', '日志', timestamp)
  await assert.rejects(sharing.shareToNew(snapshot, 'source-session', '日志引用'), /引用卡片/u)
  assert.equal(fake.calls.created.length, 0)
  sharing.attachReferences()
  await assert.rejects(sharing.shareToNew(snapshot, 'unknown-session', '日志引用'), /工作区/u)
  const sessions = fake.services.sessions as { create(request: { workspaceId: string }): Promise<string> }
  const create = sessions.create
  let attempts = 0
  sessions.create = async (request) => { attempts += 1; if (attempts === 1) throw new Error('创建失败'); return create(request) }
  await assert.rejects(sharing.shareToNew(snapshot, 'source-session', '日志引用'), /创建失败/u)
  assert.deepEqual(fake.calls.navigation, [])
  await sharing.shareToNew(snapshot, 'source-session', '日志引用')
  assert.equal(attempts, 2)
  sessions.create = async () => 'source-session'
  await assert.rejects(createTerminalSharingBridge(fake.context).createTarget('source-session'), /未能创建新会话/u)
  assert.equal(fake.inputs.get('source-session')?.draft, '源会话草稿')
  sharing.dispose()
})

test('远端工作区新建保持虚拟工作区和会话 ID，由原生路由处理', async () => {
  const fake = fixture()
  const current = createVirtualSessionId('peer-1', 'current')
  const target = createVirtualSessionId('peer-1', 'new')
  const workspaceId = createVirtualWorkspaceId('peer-1', 'workspace')
  fake.inputs.set(current, { draft: '远端原草稿', attachments: [], phase: 'plain', draftRev: 0 })
  fake.services.workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId, sessionIds: [current] }] }) } }
  const sessions = fake.services.sessions as { create(request: { workspaceId: string }): Promise<string> }
  sessions.create = async (request) => {
    fake.calls.created.push(request)
    fake.inputs.set(target, { draft: '', attachments: [], phase: 'plain', draftRev: 0 })
    return target
  }
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  await sharing.shareToNew(createTerminalSnapshot(source, 'recent', '远端日志', timestamp), current, '日志引用')
  assert.deepEqual(fake.calls.created, [{ workspaceId }])
  assert.deepEqual(fake.calls.navigation, [target])
  assert.deepEqual(fake.calls.referenceSessions, [target])
  assert.equal(fake.inputs.get(current)?.draft, '远端原草稿')
  assert.equal(fake.calls.submitted, 0)
  sharing.dispose()
})

test('输入锁定、草稿版本变化和目标消失均失败，不降级覆盖草稿', async () => {
  for (const options of [{ locked: true }, { stale: true }]) {
    const fake = fixture(options)
    await assert.rejects(createTerminalSharingBridge(fake.context).insert('target-session', '日志'))
    assert.equal(fake.inputs.get('target-session')?.draft, '请帮我分析现有问题')
    assert.equal(fake.calls.persisted, 0)
  }
  await assert.rejects(createTerminalSharingBridge(fixture().context).insert('gone-session', '日志'))
})

test('没有语义草稿保存接口时在插入之前失败，保留已有内容', async () => {
  const fake = fixture()
  const conversation = fake.services.conversation as { input: { for(scope: { sessionId: string }): any } }
  const inputFor = conversation.input.for
  conversation.input.for = (scope) => {
    const input = inputFor(scope)
    delete input.actions.persistDraft
    return input
  }
  await assert.rejects(createTerminalSharingBridge(fake.context).insert('target-session', '日志'), /草稿保存接口/u)
  assert.equal(fake.calls.text.length, 0)
  assert.equal(fake.inputs.get('target-session')?.draft, '请帮我分析现有问题')
})

test('卡片序列化将固定正文送入 prompt，停用后释放引用源注册', async () => {
  const fake = fixture()
  const sharing = new TerminalSharing()
  const detach = sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  assert.ok(sharing.canReference())
  const snapshot = createTerminalSnapshot(source, 'recent', 'failed', timestamp)
  await sharing.share(snapshot, 'target-session', '终端：测试终端')
  const reference = fake.calls.references[0] as { source: string; ref: string }
  const codec = fake.registry.get(reference.source).codec
  assert.equal(await codec.serialize(reference.ref, new AbortController().signal), formatTerminalSnapshot(snapshot))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(codec.serialize(reference.ref, abort.signal))
  detach()
  assert.equal(fake.registry.size, 0)
  assert.equal(sharing.canReference(), false)
  await assert.rejects(sharing.targets('source-session'))
})

test('点击恢复的日志卡片预览固定正文，不依赖终端读取器，不修改或发送草稿', () => {
  const fake = fixture()
  const drafts = structuredClone([...fake.inputs.entries()])
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  let changes = 0
  const unsubscribe = sharing.subscribePreview(() => { changes += 1 })
  const snapshot = createTerminalSnapshot(source, 'selection', '旧日志\n  中文与🙂', timestamp)
  const ref = JSON.parse(JSON.stringify({ ref: encodeTerminalSnapshot(snapshot) })).ref
  const owner = fake.registry.get('codingns-terminal-log')
  assert.equal(owner.openReference({ sessionId: 'target-session' }, { ref, appearance: 'file' }), true)
  const state = sharing.getPreviewSnapshot()!
  assert.ok('snapshot' in state)
  assert.deepEqual(state.snapshot, snapshot)
  assert.equal(sharing.getPreviewSnapshot(), state, '未变化时必须返回同一个快照对象')
  const second = createTerminalSnapshot(source, 'recent', '另一张卡片的日志', timestamp)
  owner.openReference({}, { ref: encodeTerminalSnapshot(second) })
  assert.deepEqual(sharing.getPreviewSnapshot(), { snapshot: second })
  sharing.closePreview()
  assert.equal(sharing.getPreviewSnapshot(), undefined)
  assert.equal(changes, 3)
  sharing.closePreview()
  assert.equal(changes, 3)
  assert.deepEqual([...fake.inputs.entries()], drafts)
  assert.deepEqual(fake.calls.navigation, [])
  assert.equal(fake.calls.focused, 0)
  assert.equal(fake.calls.persisted, 0)
  assert.equal(fake.calls.submitted, 0)
  unsubscribe()
  sharing.dispose()
})

test('损坏引用显示预览错误；重新注册及服务停用关闭预览并拒绝旧点击回调', () => {
  const fake = fixture()
  const sharing = new TerminalSharing()
  const detachBridge = sharing.attachBridge(createTerminalSharingBridge(fake.context))
  const detachReferences = sharing.attachReferences()
  const oldOwner = fake.registry.get('codingns-terminal-log')
  assert.equal(oldOwner.openReference({}, { ref: '{broken' }), true)
  assert.deepEqual(sharing.getPreviewSnapshot(), { error: resolveCodingNsTranslator()('terminalShare.preview.invalid') })
  detachReferences()
  assert.equal(sharing.getPreviewSnapshot(), undefined)
  assert.equal(oldOwner.openReference({}, { ref: '{}' }), false)
  sharing.attachReferences()
  assert.equal(oldOwner.openReference({}, { ref: '{}' }), false)
  const owner = fake.registry.get('codingns-terminal-log')
  const ref = encodeTerminalSnapshot(createTerminalSnapshot(source, 'recent', '保留的日志', timestamp))
  assert.equal(owner.openReference({}, { ref }), true)
  detachBridge()
  assert.equal(sharing.getPreviewSnapshot(), undefined)
  assert.equal(owner.openReference({}, { ref }), false)
  assert.equal(fake.calls.submitted, 0)
  sharing.dispose()
})

test('预览原样显示日志空白和中文，HTML 作为纯文本转义，截断与损坏状态可读', () => {
  const t = resolveCodingNsTranslator()
  const snapshot = createTerminalSnapshot(source, 'selection', '<script>alert(1)</script>\n  中文\t🙂\n<img src=x onerror=alert(1)>', timestamp)
  const html = renderToStaticMarkup(createElement(TerminalLogPreviewContent, { state: { snapshot }, t }))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;\n  中文\t🙂\n&lt;img src=x onerror=alert(1)&gt;'))
  assert.doesNotMatch(html, /<script|<img/u)
  assert.match(html, /<pre[^>]*tabindex="0"[^>]*aria-label="终端日志"/u)
  const truncated = createTerminalSnapshot(source, 'selection', Array.from({ length: 201 }, (_item, index) => String(index)).join('\n'), timestamp)
  const retainedHtml = renderToStaticMarkup(createElement(TerminalLogPreviewContent, { state: { snapshot: truncated }, t }))
  assert.ok(retainedHtml.includes(t('terminalShare.snapshot.truncated')))
  assert.ok(retainedHtml.includes(truncated.text))
  const errorHtml = renderToStaticMarkup(createElement(TerminalLogPreviewContent, { state: { error: t('terminalShare.preview.invalid') }, t }))
  assert.match(errorHtml, /role="alert"/u)
  assert.doesNotMatch(errorHtml, /<pre/u)
})

test('固定卡片分享缺少原生引用插入接口时失败，不回退文本块', async () => {
  const fake = fixture({ reference: false })
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  await assert.rejects(sharing.share(createTerminalSnapshot(source, 'recent', '错误', timestamp), 'target-session', '日志'))
  assert.equal(fake.calls.text.length, 0)
  assert.equal(fake.calls.references.length, 0)
  sharing.dispose()
  assert.equal(sharing.canReference(), false)
})

test('引用插入版本冲突时不重复回退文本', async () => {
  const fake = fixture({ stale: true })
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  sharing.attachReferences()
  await assert.rejects(sharing.share(createTerminalSnapshot(source, 'recent', '错误', timestamp), 'target-session', '日志'))
  assert.equal(fake.calls.text.length, 0)
  assert.equal(fake.calls.references.length, 0)
  assert.equal(fake.calls.persisted, 0)
  sharing.dispose()
})

test('引用服务缺失或停用后会话菜单可用，但禁止用文本代替引用卡片', async () => {
  const fake = fixture()
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  const detachReferences = sharing.attachReferences()
  detachReferences()
  assert.equal(sharing.canReference(), false)
  assert.equal(fake.registry.size, 0)
  assert.equal((await sharing.targets('source-session')).length, 2)
  delete fake.services.inputTriggers
  sharing.attachReferences()
  await assert.rejects(sharing.share(createTerminalSnapshot(source, 'recent', '错误', timestamp), 'target-session', '日志'))
  assert.equal(fake.calls.text.length, 0)
  sharing.dispose()
})

test('同 ID 的不同终端视图互不污染，重连旧清理函数不会删除新读取器', () => {
  const fake = fixture()
  const sharing = new TerminalSharing()
  sharing.attachBridge(createTerminalSharingBridge(fake.context))
  const view = (sessionId: string) => ({
    id: 'same-terminal-id', sessionId,
    state: { getSnapshot: () => ({ info: { title: '终端', shell: { name: 'zsh' }, cwd: '/workspace' } }) },
  }) as unknown as CodingNsTerminalView
  const local = view('source-session')
  const remote = view(createVirtualSessionId('peer-1', 'remote-session'))
  const releaseOld = sharing.bind(local, reader([{ text: '旧连接' }]))
  const releaseNew = sharing.bind(local, reader([{ text: '本地日志' }]))
  sharing.bind(remote, reader([{ text: '远端日志' }]))
  releaseOld()
  assert.equal(sharing.capture(local).text, '本地日志')
  assert.equal(sharing.capture(local).sourceWorkspaceId, 'workspace-1')
  assert.equal(sharing.capture(remote).text, '远端日志')
  assert.equal(sharing.capture(remote).sourceHostId, 'peer-1')
  releaseNew()
  assert.throws(() => sharing.capture(local))
  sharing.dispose()
  assert.throws(() => sharing.capture(remote))
})

test('目标列表排除归档、保留跨 Host 虚拟 ID 和工作区名称', () => {
  const remote = createVirtualSessionId('peer-1', 'target')
  const workspace = createVirtualWorkspaceId('peer-1', 'workspace')
  const targets = readTerminalShareTargets([{ sessionId: remote, title: '远端会话', adapterId: 'codex' }, { sessionId: 'archived' }, { sessionId: 'archived-at', archivedAt: 1 }],
    { items: [{ workspaceId: workspace, title: '远端项目', sessionIds: [remote] }], archivedSessionIds: ['archived'] })
  assert.deepEqual(targets, [{ sessionId: remote, title: '远端会话', workspaceId: workspace, workspaceTitle: '远端项目', hostId: 'peer-1', adapterId: 'codex' }])
})

test('目标列表按原生 blank 排除本地和远端草稿，保留未命名正式会话及旧摘要', () => {
  const remoteDraft = createVirtualSessionId('peer-1', 'draft')
  const rows = [
    { sessionId: 'draft', blank: true, title: '未命名会话' },
    { sessionId: remoteDraft, blank: true, title: '已有标题的草稿' },
    { sessionId: 'unnamed', blank: false, title: '' },
    { sessionId: 'legacy', title: '旧摘要' },
  ]
  assert.deepEqual(readTerminalShareTargets(rows, {}).map((item) => item.sessionId), ['unnamed', 'legacy'])
})

test('会话菜单仅显示当前工作区，初始最多五项，当前会话也按更新时间排序', () => {
  const workspace = { items: [{ workspaceId: 'workspace-1', sessionIds: ['current', 'old', 'a', 'b', 'c', 'd', 'e', 'archived', 'draft'] }], archivedSessionIds: ['archived'] }
  const rows = [
    { sessionId: 'current', updatedAt: 1 }, { sessionId: 'old', updatedAt: 2 },
    ...['a', 'b', 'c', 'd', 'e'].map((sessionId, index) => ({ sessionId, updatedAt: 10 + index })),
    { sessionId: 'other-workspace', workspaceId: 'workspace-2', updatedAt: 100 }, { sessionId: 'archived', updatedAt: 101 },
    { sessionId: 'draft', blank: true, updatedAt: 102 },
  ]
  const targets = readTerminalShareTargets(rows, workspace)
  assert.deepEqual(selectRecentTerminalShareTargets(targets, workspace, 'current').map((item) => item.sessionId), ['e', 'd', 'c', 'b', 'a'])
  assert.equal(selectRecentTerminalShareTargets(targets, workspace, 'current', 10).length, 7)
  assert.equal(selectRecentTerminalShareTargets([], workspace, 'archived').some((item) => item.sessionId === 'archived'), false)
  assert.deepEqual(selectRecentTerminalShareTargets([], workspace, 'current'), [])
  const unknownWorkspace = readTerminalShareTargets([{ sessionId: 'current' }, { sessionId: 'another' }], {})
  assert.deepEqual(selectRecentTerminalShareTargets(unknownWorkspace, {}, 'current').map((item) => item.sessionId), ['current'])
})

test('菜单复用完整原生摘要，否则补读一次并透传取消；保留活跃会话最新时间', async () => {
  const fake = fixture()
  const ids = ['source-session', 'target-session', 'a', 'b', 'c', 'd']
  const rows = Object.fromEntries(ids.map((sessionId, index) => [sessionId, { updatedAt: index + 1 }]))
  rows.c!.updatedAt = 50
  fake.services.workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', sessionIds: ids }] }) } }
  fake.services.sessions = { scope: () => undefined, list: { getSnapshot: () => ({ byId: rows }) } }
  let requests = 0
  const controller = new AbortController()
  fake.services['remote.session'] = { list: async (_request: unknown, signal: AbortSignal) => {
    requests += 1
    assert.equal(signal, controller.signal)
    return { ok: true, value: { items: ids.map((sessionId, index) => ({ sessionId, title: sessionId, updatedAt: index + 1 })), nextCursor: 'unused' } }
  } }
  const bridge = createTerminalSharingBridge(fake.context)
  assert.equal((await bridge.targets(undefined, { sessionId: 'source-session', limit: 5 })).length, 5)
  assert.equal(requests, 0)
  delete rows.d
  const targets = await bridge.targets(controller.signal, { sessionId: 'source-session', limit: 5 })
  assert.equal(requests, 1)
  assert.deepEqual(targets.map((item) => item.sessionId), ['c', 'd', 'b', 'a', 'target-session'])
})

test('缓存与补读摘要均过滤草稿，原生活跃摘要的草稿状态优先', async () => {
  const fake = fixture()
  const rows: Record<string, { blank: boolean }> = {
    'source-session': { blank: true }, 'target-session': { blank: false },
    'loaded-draft': { blank: true }, 'fetched-draft': { blank: true }, 'fetched-session': { blank: false },
  }
  const ids = Object.keys(rows)
  fake.services.sessions = { scope: () => undefined, list: { getSnapshot: () => ({ byId: rows }) } }
  fake.services.workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', sessionIds: ids }] }) } }
  let requests = 0
  fake.services['remote.session'] = { list: async () => {
    requests += 1
    return { ok: true, value: { items: [
      { sessionId: 'source-session', blank: false },
      { sessionId: 'fetched-draft', blank: true }, { sessionId: 'fetched-session', blank: false },
    ] } }
  } }
  const bridge = createTerminalSharingBridge(fake.context)
  const query = { sessionId: 'source-session', limit: 5 }
  assert.deepEqual((await bridge.targets(undefined, query)).map((item) => item.sessionId), ['target-session', 'fetched-session'])
  assert.equal(requests, 0)
  delete rows['fetched-draft']
  delete rows['fetched-session']
  assert.deepEqual((await bridge.targets(undefined, query)).map((item) => item.sessionId), ['target-session', 'fetched-session'])
  assert.equal(requests, 1)
})

test('选区按钮靠近末端且不会越出移动端可视窗口，屏外选区不显示', () => {
  const rect = { left: 20, top: 100, width: 300, height: 240 }
  const viewport = { left: 0, top: 50, width: 360, height: 300 }
  const position = positionTerminalSelectionActions(rect, { x: 78, y: 25 }, 80, 24, 10, viewport)!
  assert.ok(position.left >= 8 && position.left + 152 <= viewport.width)
  assert.ok(position.top >= viewport.top + 8 && position.top + 34 <= viewport.top + viewport.height - 8)
  assert.ok(positionTerminalSelectionActions(rect, { x: 0, y: 34 }, 80, 24, 10, viewport), '最后一整行选区应仍显示按钮')
  assert.equal(positionTerminalSelectionActions(rect, { x: 1, y: 9 }, 80, 24, 10, viewport), undefined)
})

test('拖选完成后显示复制分享按钮，清空选区、滚动和销毁均正确收尾', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const view = Object.assign(new EventTarget(), {
    innerWidth: 800, innerHeight: 600, visualViewport: undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const container = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: view }, getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 240 }),
  })
  let text = '完整选中的日志\n第二行'
  let change: (() => void) | undefined
  let scroll: (() => void) | undefined
  const terminal = {
    cols: 80, rows: 24, buffer: { active: { viewportY: 0 } },
    getSelection: () => text, getSelectionPosition: () => ({ end: { x: 10, y: 3 } }),
    onSelectionChange: (callback: () => void) => { change = callback; return { dispose: () => { change = undefined } } },
    onScroll: (callback: () => void) => { scroll = callback; return { dispose: () => { scroll = undefined } } },
  }
  const states: unknown[] = []
  const dispose = installTerminalSelectionActions(terminal, container as unknown as HTMLElement, (state) => states.push(state))
  const flush = () => { for (const callback of [...frames.values()]) callback(0); frames.clear() }
  container.dispatchEvent(new Event('pointerdown'))
  change?.()
  assert.equal(frames.size, 0, '拖动中不能弹出浮层')
  view.dispatchEvent(new Event('pointerup'))
  flush()
  assert.equal((states.at(-1) as { text: string }).text, text)
  scroll?.()
  assert.equal(states.at(-1), undefined)
  text = ''
  change?.()
  flush()
  assert.equal(states.at(-1), undefined)
  text = '新的选区'
  change?.()
  assert.equal(frames.size, 1)
  dispose()
  assert.equal(frames.size, 0)
  assert.equal(change, undefined)
  assert.equal(scroll, undefined)
  const count = states.length
  container.dispatchEvent(new Event('pointerdown'))
  view.dispatchEvent(new Event('pointerup'))
  assert.equal(states.length, count)
})

test('目标列表来源归属和取消请求', async () => {
  const fake = fixture()
  const bridge = createTerminalSharingBridge(fake.context)
  assert.equal((await bridge.targets()).length, 2)
  assert.deepEqual(bridge.source('source-session'), { hostId: 'local', workspaceId: 'workspace-1' })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(bridge.targets(aborted.signal))
})

test('会话分页合并去重，重复游标与接口错误明确失败', async () => {
  const fake = fixture()
  const cursors: (string | undefined)[] = []
  fake.services['remote.session'] = { list: async ({ cursor }: { cursor?: string }) => {
    cursors.push(cursor)
    return { ok: true, value: cursor === undefined
      ? { items: [{ sessionId: 'source-session', title: '第一页' }], nextCursor: 'page-2' }
      : { items: [{ sessionId: 'source-session', title: '更新标题' }, { sessionId: 'target-session' }] } }
  } }
  const bridge = createTerminalSharingBridge(fake.context)
  const targets = await bridge.targets()
  assert.deepEqual(cursors, [undefined, 'page-2'])
  assert.equal(targets.length, 2)
  assert.equal(targets[0]?.title, '更新标题')
  fake.services['remote.session'] = { list: async () => ({ ok: true, value: { items: [], nextCursor: 'same' } }) }
  await assert.rejects(bridge.targets(), /分页游标重复/u)
  fake.services['remote.session'] = { list: async () => ({ ok: false, error: { message: 'Host 已断开' } }) }
  await assert.rejects(bridge.targets(), /Host 已断开/u)
})

test('目标在选择之后归档时拒绝插入，不修改任一草稿', async () => {
  for (const duringNavigation of [false, true]) {
    const fake = fixture()
    const archived: string[] = duringNavigation ? [] : ['target-session']
    fake.services.workspaces = { list: { getSnapshot: () => ({ items: [], archivedSessionIds: archived }) } }
    if (duringNavigation) fake.services.uiWorkspace = { openSession: () => { archived.push('target-session') } }
    await assert.rejects(createTerminalSharingBridge(fake.context).insert('target-session', '错误'), /归档/u)
    assert.equal(fake.calls.text.length, 0)
    assert.equal(fake.inputs.get('target-session')?.draft, '请帮我分析现有问题')
  }
})

test('远端会话以完整虚拟 ID 导航并插入其独立草稿', async () => {
  const fake = fixture()
  const sessionId = createVirtualSessionId('peer-1', 'remote-session')
  const workspaceId = createVirtualWorkspaceId('peer-1', 'remote-workspace')
  fake.inputs.set(sessionId, { draft: '远端问题', attachments: ['远端附件'], phase: 'plain', draftRev: 7 })
  fake.services.workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId, sessionIds: [sessionId], title: '远端工作区' }] }) } }
  const bridge = createTerminalSharingBridge(fake.context)
  await bridge.insert(sessionId, '远端终端快照')
  assert.deepEqual(fake.calls.navigation, [sessionId])
  assert.deepEqual(bridge.source(sessionId), { hostId: 'peer-1', workspaceId })
  assert.match(fake.inputs.get(sessionId)!.draft, /^远端问题\n\n远端终端快照/u)
  assert.deepEqual(fake.inputs.get(sessionId)!.attachments, ['远端附件'])
  assert.equal(fake.inputs.get('source-session')?.draft, '源会话草稿')
  assert.equal(fake.inputs.get('target-session')?.draft, '请帮我分析现有问题')
})

test('新能力只在已支持的 DSH 世代启用，旧世代明确不可用', () => {
  const fake = fixture()
  assert.ok(supportsTerminalSharing(fake.context))
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2']) {
    const profile = createDshCapabilityRegistry(version, 'client', fake.context).getProfile(fake.context)
    assert.equal(profile.capabilities.get('conversation.draft-share')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some((item) => item.capability === 'conversation.draft-share'))
  }
  for (const version of ['0.2.1-alpha.1']) {
    assert.equal(createDshCapabilityRegistry(version, 'client', fake.context).getProfile(fake.context).capabilities.get('conversation.draft-share')?.status, 'ready')
  }
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.1', 'client', {}).getProfile({}).capabilities.get('conversation.draft-share')?.status, 'unavailable')
})

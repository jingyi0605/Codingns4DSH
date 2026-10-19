import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement, useMemo, useSyncExternalStore } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPeerHostPageTransport } from '../src/client/features/peer-host.js'
import { zh } from '../src/client/locales/peerHost.js'
import { installPeerHostAttachmentIntake } from '../src/dsh-capabilities/client/peer-host-attachment-adapter.js'
import { createSessionPerformancePresentation } from '../src/dsh-capabilities/client/session-performance-adapter.js'
import { GROK_CONTEXT_PROJECTION } from '../src/shared/request-performance.js'
import { installDshPeerHostPrebootShim } from '../src/bootstrap/dsh-peer-host-preboot-shim.js'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { rewriteNativeRequestIds } from '../src/host/modules/peer-host/peer-host-native-protocol.js'
import { createPresentationSlots } from './fixtures/presentation-slots.ts'

test('PeerHost intake uploads native-path files to their session Host and preserves local references', async () => {
  const originalFetch = globalThis.fetch
  const slots = createPresentationSlots()
  const paths = new WeakMap<File, string>()
  const references: string[] = []
  const uploads: Array<{ sessionId: string; file: File }> = []
  const forwarded: Array<{ files: readonly File[]; directories?: ReadonlySet<File> }> = []
  let intake: (files: readonly File[], directories?: ReadonlySet<File>) => string | null
  const root = slots.register({ name: 'root', children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  } }, (() => null) as never)
  const Native = (props: any) => { intake = props.addFiles; return null }
  const inject = (sessionId: string) => ({
    addFiles(files: readonly File[], directories?: ReadonlySet<File>) {
      forwarded.push({ files, directories })
      for (const file of files) {
        const path = paths.get(file) ?? ''
        if (path !== '') references.push(path)
        else uploads.push({ sessionId, file })
      }
      return null
    },
  })
  const native = slots.register({ name: 'conversation.composer.bar', inject, children: {
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
  } }, Native as never)
  const remoteCalls: any[] = []
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    remoteCalls.push(request.payload)
    if (request.payload.method === 'session/prompt') return Response.json({ result: { ok: true, value: { accepted: true } } })
    return Response.json({ result: { ok: true, value: {
      receiptId: `${request.payload.scope.targetHostId}-receipt`,
      file: { attachmentId: 'remote-file', name: 'report.txt', bytes: 4 },
    } } })
  }) as typeof fetch
  const transport = createPeerHostPageTransport(undefined, { get: name => name === 'slots' ? slots : undefined })
  const aggregate = ['peer-a', 'peer-b'].map(targetHostId => ({
    hostId: 'local', targetHostId, hostLabel: targetHostId, availability: 'ready', errorCode: null,
    workspaces: [{ workspaceId: 'workspace-1', path: '/remote/repo', displayName: 'Remote', sessions: [{
      scope: { hostId: 'local', targetHostId, workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
      title: 'Remote', status: 'idle', updatedAt: 1,
    }] }],
  }))
  transport.setAggregate(aggregate as never)
  const render = (sessionId: string) => {
    const entry = slots.core.entriesOfSlot('conversation.composer.bar')[0]!
    renderToStaticMarkup(createElement(entry.component as any, { sessionId, ...inject(sessionId) }))
  }
  try {
    const file = new File([new Uint8Array([0, 45, 128, 255])], 'report.txt', { type: 'text/plain', lastModified: 42 })
    paths.set(file, '/local/repo/report.txt')
    for (const host of ['peer-a', 'peer-b']) {
      const sessionId = createVirtualSessionId(host, 'session-1')
      render(sessionId)
      assert.equal(intake!([file]), null)
      assert.equal(references.length, 0, 'a client filesystem path cannot become a remote reference')
      const uploaded = uploads.at(-1)!
      assert.equal(uploaded.sessionId, sessionId)
      assert.notEqual(uploaded.file, file)
      assert.equal(uploaded.file.name, file.name)
      assert.equal(uploaded.file.type, file.type)
      assert.equal(uploaded.file.lastModified, file.lastModified)
      assert.deepEqual(await uploaded.file.arrayBuffer(), await file.arrayBuffer())
      const response = await transport.hooks.fetch!(`api/session/uploadFileBinary?${new URLSearchParams({ sessionId, name: file.name })}`, {
        method: 'POST', body: uploaded.file,
      })
      const receipt = (await response.json()).value.receiptId
      assert.equal(receipt, `${host}-receipt`)
      const call = remoteCalls.at(-1)
      assert.equal(call.scope.targetHostId, host)
      assert.equal(call.scope.workspaceId, 'workspace-1')
      assert.equal(call.payload.args.agentId, sessionId)
      assert.equal(call.payload.args.request.data, 'AC2A/w==')
      const content = [{ type: 'file', receiptId: receipt }]
      const result = await transport.hooks.rpc!({ method: 'session/prompt', payload: {
        channel: '/api', payload: { args: { request: { sessionId, requestId: 'prompt-1', mode: 'queue', content } } },
      } })
      assert.deepEqual(result, { ok: true, value: { accepted: true } })
      const prompt = remoteCalls.at(-1)
      assert.equal(prompt.scope.targetHostId, host)
      const rewritten = rewriteNativeRequestIds('session/prompt', prompt.payload, {
        resolveWorkspace: () => null,
        resolveSession: id => id === sessionId ? { sessionId: 'session-1', targetHostId: host } : null,
      }) as any
      assert.equal(rewritten.args.request.sessionId, 'session-1')
      assert.deepEqual(rewritten.args.request.content, content, 'the target-owned upload receipt reaches the same Host unchanged')
    }

    render('local-session')
    const files = [file]
    const directories = new Set([file])
    assert.equal(intake!(files, directories), null)
    assert.equal(forwarded.at(-1)!.files, files)
    assert.equal(forwarded.at(-1)!.directories, directories)
    assert.deepEqual(references, ['/local/repo/report.txt'])

    render(createVirtualSessionId('peer-a', 'session-1'))
    const count = forwarded.length
    assert.equal(intake!(files, directories), zh['peerHost.attachmentFolderUnsupported'])
    assert.equal(forwarded.length, count, 'remote folders must not become local path references')

    transport.setAggregate([])
    assert.equal(intake!([file]), null)
    const response = await transport.hooks.fetch!(`api/session/uploadFileBinary?${new URLSearchParams({ sessionId: uploads.at(-1)!.sessionId })}`, {
      method: 'POST', body: uploads.at(-1)!.file,
    })
    assert.equal((await response.json()).error.code, 'PEER_HOST_SCOPE_MISMATCH')
    assert.equal(remoteCalls.length, 4)
  } finally {
    transport.dispose()
    assert.equal(slots.core.entriesOfSlot('conversation.composer.bar')[0]!.component, Native)
    globalThis.fetch = originalFetch
    native(); root()
  }
})

for (const peerFirst of [true, false]) test(`attachment intake composes with native context UI in either installation order (peer first: ${peerFirst})`, async () => {
  const slots = createPresentationSlots()
  const context = { get slots() { return new Proxy(slots, {}) }, get: () => new Proxy(slots, {}) }
  const root = slots.register({ name: 'root', children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  } }, (() => null) as never)
  const installPeer = () => installPeerHostAttachmentIntake(context, 'individual files only')
  const installPerformance = () => createSessionPerformancePresentation(context).install(() => 'grok', createElement, { useMemo, useSyncExternalStore })
  const first = peerFirst ? installPeer() : installPerformance()
  const second = peerFirst ? installPerformance() : installPeer()
  let received: any
  const Native = (props: any) => { received = props; return null }
  const registerNative = () => slots.register({ name: 'conversation.composer.bar', children: {
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
  } }, Native as never)
  let removeNative = registerNative()
  await Promise.resolve()
  const file = new File(['data'], 'report.txt')
  let files: readonly File[] = []
  const render = () => {
    renderToStaticMarkup(createElement(slots.core.entriesOfSlot('conversation.composer.bar')[0]!.component as any, {
      sessionId: createVirtualSessionId('peer-a', 'session-1'), addFiles: (items: readonly File[]) => { files = items },
      useProjection: (key: string) => key === GROK_CONTEXT_PROJECTION ? { pressureTokens: 42 } : { pressureTokens: 100 },
    }))
  }
  try {
    assert.equal(slots.entries('conversation.composer.bar').length, 2, 'both customizations share one native wrapper')
    render()
    received.addFiles([file])
    assert.notEqual(files[0], file)
    assert.deepEqual(received.useProjection('contextPressure'), { pressureTokens: 42 })
    assert.equal(received.useProjection('contextBreakdown'), undefined)
    removeNative()
    await Promise.resolve()
    removeNative = registerNative()
    await Promise.resolve()
    render()
    received.addFiles([file])
    assert.notEqual(files[0], file)
    first()
    render()
    received.addFiles([file])
    assert.equal(files[0] === file, peerFirst)
    assert.deepEqual(received.useProjection('contextPressure'), { pressureTokens: peerFirst ? 42 : 100 })
    second()
    assert.equal(slots.core.entriesOfSlot('conversation.composer.bar')[0]!.component, Native)
  } finally { first(); second(); removeNative(); root() }
})

const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR
  ?? join(homedir(), `.local/share/codingns/deepseek-harness/${DSH_TESTED_VERSION}/node_modules/@deepseek-ai`)
const uploadRuntimePath = join(runtime, 'dsh-client-file-upload/lib/types/client/runtime.js')

test('official upload client uses PeerHost for Blob, stream, and bytes, preserving target errors and cancellation', { skip: !existsSync(uploadRuntimePath) }, async () => {
  const [{ Context }, { FileUploadRuntime }] = await Promise.all([
    import(pathToFileURL(join(runtime, 'cordis/lib/index.js')).href),
    import(pathToFileURL(uploadRuntimePath).href),
  ])
  const originalFetch = globalThis.fetch
  const sessionId = createVirtualSessionId('peer-a', 'session-1')
  const calls: any[] = []
  let failure = false
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/codingns/peerHost/native', 'the client must never upload to the local HTTP endpoint')
    const envelope = JSON.parse(String(init?.body))
    calls.push(envelope.payload)
    return Response.json({ result: failure
      ? { ok: false, error: { code: 'session/attachment-invalid', message: 'Target storage rejected the file' } }
      : { ok: true, value: { receiptId: 'remote-receipt', file: { attachmentId: 'remote-file', name: 'report.txt', bytes: 4 } } },
    })
  }) as typeof fetch
  const shim = installDshPeerHostPrebootShim({ dshVersion: DSH_TESTED_VERSION })
  const transport = createPeerHostPageTransport()
  transport.setAggregate([{
    hostId: 'local', targetHostId: 'peer-a', hostLabel: 'Remote', availability: 'ready', errorCode: null,
    workspaces: [{ workspaceId: 'workspace-1', path: '/remote/repo', displayName: 'Remote', sessions: [{
      scope: { hostId: 'local', targetHostId: 'peer-a', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
      title: 'Remote', status: 'idle', updatedAt: 1,
    }] }],
  }] as never)
  shim.activate(transport.hooks)
  const context = new Context()
  context.provide('remote', { fileUploads: { upload: (agentId: string, request: unknown, signal?: AbortSignal) => transport.hooks.rpc!({
    method: 'fileUploads/upload', payload: { channel: '/api', payload: { args: { agentId, request } } },
    ...(signal === undefined ? {} : { signal }),
  }) } })
  const fiber = context.plugin(FileUploadRuntime)
  try {
    await fiber
    const upload = context.get('fileUpload')
    const bytes = new Uint8Array([0, 45, 128, 255])
    for (const body of [new Blob([bytes]), new Blob([bytes]).stream(), bytes]) {
      const result = await upload.upload(sessionId, body, 'report.txt')
      assert.equal(result.ok, true)
      assert.equal(result.value.receiptId, 'remote-receipt')
      const call = calls.at(-1)
      assert.equal(call.scope.targetHostId, 'peer-a')
      assert.equal(call.payload.args.agentId, sessionId)
      assert.equal(call.payload.args.request.data, 'AC2A/w==')
      assert.equal(call.payload.args.request.name, 'report.txt')
    }
    failure = true
    const result = await upload.upload(sessionId, new Blob([bytes]), 'report.txt')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'session/attachment-invalid')
    assert.equal(result.error.message, 'Target storage rejected the file')
    const count = calls.length
    await assert.rejects(upload.upload(sessionId, new Blob([bytes]), 'report.txt', AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(calls.length, count)
  } finally {
    await context.fiber.dispose()
    transport.dispose()
    shim.dispose()
    globalThis.fetch = originalFetch
  }
})

import type { DshCodingNsTransport } from '../transport/dsh-transport.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from '../transport/debug.js'

export interface RemoteDshWebBoot {
  readonly dshVersion: string
  readonly contentType?: string
  readonly html: string
  readonly entry?: string
  readonly styles?: readonly string[]
  readonly scripts?: readonly string[]
  readonly capabilities?: readonly string[]
}

export interface RemoteDshWebContextOptions {
  readonly transport: DshCodingNsTransport
  readonly container: HTMLElement
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly resourceTimeoutMs?: number
  readonly debug?: DshTransportDebugLogger
}

/**
 * 一个 HostScope 对应一个独立 iframe。iframe 内的 fetch 和 WebSocket 都经由
 * postMessage 回到父页面，再由 DSH Transport 走 web.* Envelope；页面本身不接触
 * ticket、Control API 凭据或 Host 的本地地址。
 */
export class RemoteDshWebContext {
  private readonly objectUrls = new Set<string>()
  private readonly moduleUrls = new Map<string, string>()
  private readonly moduleLoads = new Map<string, Promise<string>>()
  private readonly sockets = new Map<string, string>()
  /** 请求可能来自不同生命周期的 iframe；响应必须回到原发送窗口。 */
  private readonly messageWindows = new Map<string, Window>()
  private readonly socketWindows = new Map<string, Window>()
  private readonly iframeWindows = new Set<Window>()
  /** WebSocket 只有在 Host 本地 socket 真正打开后才允许 iframe 发送首帧。 */
  private readonly socketReady = new Map<string, { resolve(): void; reject(error: Error): void }>()
  private iframeValue: HTMLIFrameElement | undefined
  private sessionIdValue: string | undefined
  private disposed = false
  private readonly onMessageBound = (event: MessageEvent<unknown>) => { void this.onMessage(event) }
  private readonly debug: DshTransportDebugLogger

  constructor(private readonly options: RemoteDshWebContextOptions) {
    if (typeof document === 'undefined') throw new Error('Remote DSH Web Context 只能运行在浏览器')
    this.debug = options.debug ?? createDshTransportDebugLogger({ side: 'h5', component: 'remote-web-bridge' })
  }

  get iframe(): HTMLIFrameElement | undefined { return this.iframeValue }
  get sessionId(): string | undefined { return this.sessionIdValue }

  async open(signal?: AbortSignal): Promise<void> {
    this.ensureOpen()
    window.addEventListener('message', this.onMessageBound)
    ;(window as Window & { __DSH_CODINGNS_REMOTE_TRANSPORT__?: DshCodingNsTransport }).__DSH_CODINGNS_REMOTE_TRANSPORT__ = this.options.transport
    const session = await this.options.transport.webRequest<{ sessionId: string; dshVersion: string }>('web.session.open', {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    }, signal)
    this.sessionIdValue = session.sessionId
    const boot = await this.options.transport.webRequest<RemoteDshWebBoot>('web.boot.get', { sessionId: session.sessionId }, signal)
    const iframe = document.createElement('iframe')
    iframe.className = 'dsh-remote-web-context'
    iframe.setAttribute('title', 'Remote DSH Web')
    // Blob URL 由父页面创建；allow-same-origin 让 srcdoc 与父页面共享 origin，
    // 否则浏览器会把 blob:https://dsh.codingns.com/... 视为跨 origin 本地资源并拒绝加载。
    iframe.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-scripts allow-same-origin')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.border = '0'
    iframe.srcdoc = await this.prepareBootHtml(boot, signal)
    this.options.container.replaceChildren(iframe)
    this.iframeValue = iframe
    if (iframe.contentWindow !== null) this.iframeWindows.add(iframe.contentWindow)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessageBound)
    for (const streamId of this.sockets.values()) this.options.transport.closeWebStream(streamId)
    this.sockets.clear()
    this.messageWindows.clear()
    this.socketWindows.clear()
    this.iframeWindows.clear()
    for (const waiter of this.socketReady.values()) waiter.reject(new Error('Remote DSH Web Context 已关闭'))
    this.socketReady.clear()
    if (this.sessionIdValue !== undefined) {
      try {
        await this.options.transport.webRequest('web.session.close', { sessionId: this.sessionIdValue })
      } catch {
        // 物理连接已断开时，Host 会随 generation 一并清理会话。
      }
    }
    for (const url of this.objectUrls) URL.revokeObjectURL(url)
    this.objectUrls.clear()
    this.iframeValue?.remove()
    this.iframeValue = undefined
    const transportWindow = window as Window & { __DSH_CODINGNS_REMOTE_TRANSPORT__?: DshCodingNsTransport }
    if (transportWindow.__DSH_CODINGNS_REMOTE_TRANSPORT__ === this.options.transport) delete transportWindow.__DSH_CODINGNS_REMOTE_TRANSPORT__
    this.sessionIdValue = undefined
  }

  private async prepareBootHtml(boot: RemoteDshWebBoot, signal?: AbortSignal): Promise<string> {
    const parser = new DOMParser()
    const documentValue = parser.parseFromString(boot.html, 'text/html')
    relaxRemoteContentSecurityPolicy(documentValue)
    // srcdoc 在 sandbox 中没有可访问的网络 origin；固定一个不可路由的基址，
    // 让 DSH Web 生成的相对 URL 仍能被 bridge 归一化为路径。
    const base = documentValue.createElement('base')
    base.href = 'https://dsh.remote.invalid/'
    documentValue.head.prepend(base)
    const scriptNodes = [...documentValue.querySelectorAll<HTMLScriptElement>('script[src]')]
    const inlineScriptNodes = [...documentValue.querySelectorAll<HTMLScriptElement>('script:not([src])')]
    const styleNodes = [...documentValue.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')]
    // modulepreload、manifest 和 favicon 指向的是不可访问的 Host 地址；模块依赖
    // 会由 loadScript 重写为 Blob URL，其他链接直接移除，避免浏览器绕过 Tunnel。
    for (const node of [...documentValue.querySelectorAll<HTMLLinkElement>('link')]) {
      const rel = (node.getAttribute('rel') ?? '').toLowerCase()
      const as = (node.getAttribute('as') ?? '').toLowerCase()
      if (rel === 'modulepreload' || rel === 'manifest' || rel === 'icon' || (rel === 'preload' && as === 'script')) node.remove()
    }
    await Promise.all([
      ...scriptNodes.map(async (node) => {
        node.removeAttribute('integrity')
        node.removeAttribute('crossorigin')
        const path = resolveRemotePath(node.getAttribute('src') ?? '')
        node.src = await this.loadScript(path, signal)
      }),
      ...inlineScriptNodes.map(async (node) => {
        const type = (node.getAttribute('type') ?? '').toLowerCase()
        // JSON 数据脚本不是可执行代码，保留给 DSH 前端读取；其余内联脚本
        // 转成 Blob 外链，以兼容 Bootstrap 的 script-src 无 unsafe-inline 策略。
        if (type === 'application/json' || type === 'application/ld+json') return
        const source = node.textContent ?? ''
        node.textContent = ''
        node.src = this.createObjectUrl(new TextEncoder().encode(source), 'text/javascript')
      }),
      ...styleNodes.map(async (node) => {
        node.removeAttribute('integrity')
        node.removeAttribute('crossorigin')
        const path = resolveRemotePath(node.getAttribute('href') ?? '')
        node.href = await this.loadStyle(path, signal)
      }),
    ])
    const bridge = documentValue.createElement('script')
    bridge.src = this.createObjectUrl(new TextEncoder().encode(createBridgeScript()), 'text/javascript')
    documentValue.head.prepend(bridge)
    return `<!doctype html>${documentValue.documentElement.outerHTML}`
  }

  private async loadScript(path: string, signal?: AbortSignal): Promise<string> {
    const cached = this.moduleUrls.get(path)
    if (cached !== undefined) return cached
    const pending = this.moduleLoads.get(path)
    if (pending !== undefined) return pending
    const load = (async () => {
      const body = await this.options.transport.webRequest<Uint8Array>('web.asset.get', { sessionId: this.sessionIdValue, path }, signal)
      let source = decodeText(body)
      // DSH client-modules 的 `require.async("./client.foo.js")` 是包内懒加载
      // 标记，必须保留给 loader 依据 manifest 生成带 ownerId/rev 的 URL；
      // 如果按聚合 URL 直接归一化，会错误变成 `/plugins/client.foo.js`。
      const references = collectRelativeReferences(source, /\.(?:js)(?:\?[^\s"'`)]*)?$/u)
        .filter((reference) => !(path.startsWith('/plugins/??') && /^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js(?:\?.*)?$/u.test(reference)))
      const replacements = await Promise.all(references.map(async (reference) => {
        const dependencyPath = resolveRelativeAssetPath(path, reference)
        return [reference, await this.loadScript(dependencyPath, signal)] as const
      }))
      for (const [reference, url] of replacements) source = source.split(reference).join(url)
      const url = this.createObjectUrl(new TextEncoder().encode(source), 'text/javascript')
      this.moduleUrls.set(path, url)
      return url
    })()
    this.moduleLoads.set(path, load)
    return load
  }

  private async loadStyle(path: string, signal?: AbortSignal): Promise<string> {
    const cached = this.moduleUrls.get(path)
    if (cached !== undefined) return cached
    const body = await this.options.transport.webRequest<Uint8Array>('web.asset.get', { sessionId: this.sessionIdValue, path }, signal)
    let source = decodeText(body)
    const references = collectCssReferences(source, /\.(?:woff2?|ttf|otf|png|svg)(?:\?[^\s"'`)]*)?$/u)
    const replacements = await Promise.all(references.map(async (reference) => {
      const dependencyPath = resolveRelativeAssetPath(path, reference)
      const dependency = await this.options.transport.webRequest<Uint8Array>('web.asset.get', { sessionId: this.sessionIdValue, path: dependencyPath }, signal)
      return [reference, this.createObjectUrl(dependency, contentTypeForPath(dependencyPath))] as const
    }))
    for (const [reference, url] of replacements) source = source.split(reference).join(url)
    const url = this.createObjectUrl(new TextEncoder().encode(source), 'text/css')
    this.moduleUrls.set(path, url)
    return url
  }

  private createObjectUrl(value: Uint8Array, contentType: string): string {
    if (!(value instanceof Uint8Array)) throw new Error('Remote DSH Web 资源必须是二进制')
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: contentType }))
    this.objectUrls.add(url)
    return url
  }

  private async onMessage(event: MessageEvent<unknown>): Promise<void> {
    const sourceWindow = event.source as Window | null
    if (this.disposed || sourceWindow === null || !this.iframeWindows.has(sourceWindow)) return
    if (!isRecord(event.data) || typeof event.data.kind !== 'string') return
    const message = event.data
    if (message.kind !== 'dsh-web-debug' && typeof message.id !== 'string') return
    if (typeof message.id === 'string') this.messageWindows.set(message.id, sourceWindow)
    if (message.kind !== 'dsh-web-debug') {
      this.debug.log('bridge.message.accepted', { kind: message.kind, id: message.id })
    }
    try {
      if (message.kind === 'dsh-web-debug') {
        const eventName = typeof message.event === 'string' ? message.event : 'unknown'
        const fields = isRecord(message.fields) ? message.fields : {}
        this.debug.log(`iframe.${eventName}`, fields)
        if (/^(bridge\.ws\.|client\.connection\.)/u.test(eventName)) {
          await this.options.transport.webRequest('web.debug', { event: eventName, fields })
        }
        return
      }
      if (message.kind === 'fetch') {
        const input = isRecord(message.input) ? message.input : {}
        const path = resolveRemotePath(typeof input.path === 'string' ? input.path : '/')
        const body = typeof message.body === 'string'
          ? message.body
          : typeof input.body === 'string'
            ? input.body
            : undefined
        const response = path.startsWith('/assets/') || path.startsWith('/plugins/')
          ? { status: 200, headers: [['content-type', 'application/octet-stream']], body: await this.options.transport.webRequest<Uint8Array>('web.asset.get', { sessionId: this.sessionIdValue, path }) }
          : await this.options.transport.webRequest<{ status: number; headers: [string, string][]; body: string }>('web.request', { sessionId: this.sessionIdValue, path, method: typeof input.method === 'string' ? input.method : 'GET', ...(Array.isArray(input.headers) ? { headers: input.headers } : {}), ...(body === undefined ? {} : { body }) })
        this.postResponse(message.id, { ok: true, status: response.status, headers: response.headers, body: response.body instanceof Uint8Array ? response.body.buffer : response.body })
        return
      }
      if (message.kind === 'script') {
        const input = isRecord(message.input) ? message.input : {}
        const path = resolveRemotePath(typeof input.path === 'string' ? input.path : '/')
        const url = await this.loadScript(path, undefined)
        this.postResponse(message.id, { ok: true, url })
        return
      }
      if (message.kind === 'style') {
        const input = isRecord(message.input) ? message.input : {}
        const path = resolveRemotePath(typeof input.path === 'string' ? input.path : '/')
        const url = await this.loadStyle(path, undefined)
        this.postResponse(message.id, { ok: true, url })
        return
      }
      if (message.kind === 'ws.open') {
        const input = isRecord(message.input) ? message.input : {}
        const opened = this.options.transport.openWebStreamWithId('web.ws.open', { sessionId: this.sessionIdValue, path: resolveRemotePath(typeof input.path === 'string' ? input.path : '/') })
        this.sockets.set(message.id, opened.streamId)
        this.socketWindows.set(message.id, sourceWindow)
        this.debug.log('bridge.ws.register', { id: message.id, streamId: opened.streamId })
        let resolveReady!: () => void
        let rejectReady!: (error: Error) => void
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        this.socketReady.set(message.id, { resolve: resolveReady, reject: rejectReady })
        this.debug.log('bridge.ws.open', { id: message.id, streamId: opened.streamId, path: resolveRemotePath(typeof input.path === 'string' ? input.path : '/') })
        void this.consumeSocket(message.id, opened.streamId, opened.stream)
        // 不再把 stream.open/stream.accepted 当作 WebSocket open。只有 Host
        // 已完成本地 WebSocket 握手并发回 web.ws.open.response，iframe 才能
        // 发送 /api/remote.mux 的首个 DSH Connection 帧。
        await ready
        if (!this.disposed && this.sockets.get(message.id) === opened.streamId) {
          this.debug.log('bridge.ws.open.response', { id: message.id, streamId: opened.streamId })
          this.postResponse(message.id, { ok: true })
        }
        return
      }
      if (message.kind === 'ws.send') {
        const streamId = this.sockets.get(message.id)
        this.debug.log('bridge.ws.receive', { id: message.id, hasSocket: streamId !== undefined, streamId: streamId ?? null })
        if (!streamId) throw new Error('Remote DSH WebSocket 不存在')
        const body = typeof message.body === 'string' ? new TextEncoder().encode(message.body) : toBytes(message.body)
        this.debug.log('bridge.ws.send', { id: message.id, streamId, bytes: body.byteLength, encoding: typeof message.body === 'string' ? 'text' : 'binary' })
        try {
          this.options.transport.sendWebStream(streamId, 'web.ws.data', body, { ...(typeof message.body === 'string' ? { encoding: 'text' } : { binary: true }) })
          this.debug.log('bridge.ws.data.sent', { id: message.id, streamId, bytes: body.byteLength })
        } catch (error) {
          this.debug.log('bridge.ws.data.error', { id: message.id, streamId, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
        return
      }
      if (message.kind === 'ws.close') {
        const streamId = this.sockets.get(message.id)
        if (streamId) this.options.transport.closeWebStream(streamId)
        this.debug.log('bridge.ws.close', { id: message.id, streamId })
        this.sockets.delete(message.id)
        this.socketWindows.delete(message.id)
      }
    } catch (error) {
      this.postResponse(message.id, { ok: false, error: error instanceof Error ? error.message : 'Remote DSH Web 请求失败' })
    }
  }

  private async consumeSocket(id: string, streamId: string, stream: AsyncIterable<unknown>): Promise<void> {
    let opened = false
    try {
      for await (const value of stream) {
        if (!opened) {
          opened = true
          if (isRecord(value) && value.opened === true) {
            this.socketReady.get(id)?.resolve()
            this.socketReady.delete(id)
            continue
          }
        }
        if (value instanceof Uint8Array) {
          this.debug.log('bridge.ws.message', { id, streamId, bytes: value.byteLength, encoding: 'binary' })
          this.postEvent(id, 'message', value.buffer)
        } else {
          const body = typeof value === 'string' ? value : JSON.stringify(value)
          this.debug.log('bridge.ws.message', { id, streamId, bytes: new TextEncoder().encode(body).byteLength, encoding: 'text' })
          this.postEvent(id, 'message', body)
        }
      }
      this.postEvent(id, 'close', undefined)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Remote DSH WebSocket 流失败')
      this.socketReady.get(id)?.reject(failure)
      this.socketReady.delete(id)
      this.postEvent(id, 'error', error instanceof Error ? error.message : 'Remote DSH WebSocket 流失败')
    } finally {
      if (!opened) {
        const failure = new Error('Remote DSH WebSocket 未收到 Host open 响应')
        this.socketReady.get(id)?.reject(failure)
        this.socketReady.delete(id)
      }
      if (this.sockets.get(id) === streamId) this.sockets.delete(id)
      this.socketWindows.delete(id)
      this.debug.log('bridge.ws.consume.finally', { id, streamId, hasSocket: this.sockets.has(id) })
    }
  }

  private postResponse(id: string, value: Record<string, unknown>): void {
    this.messageWindows.get(id)?.postMessage({ kind: 'dsh-web-response', id, ...value }, '*')
  }

  private postEvent(id: string, type: string, body: unknown): void {
    this.socketWindows.get(id)?.postMessage({ kind: 'dsh-web-event', id, type, body }, '*')
  }

  private ensureOpen(): void { if (this.disposed) throw new Error('Remote DSH Web Context 已关闭') }
}

function createBridgeScript(): string {
  return `(() => {
    // 远程 DSH Web 已经运行在外层 DSH-CodingNS Tunnel 内。
    // 内嵌的 dsh-codingns Client 仍需加载其插件代码和界面，但不能再次启动
    // 自己的 Relay/WebRTC，否则会把信令 WebSocket 当成本地 DSH Web 路径转发，
    // 形成递归连接并持续触发 /signaling/signal 失败。
    globalThis.__DSH_CODINGNS_REMOTE_WEB_CONTEXT__ = true;
    const bridgeDebugEnabled = (() => {
      try {
        const query = new URL(parent.location.href).searchParams.get('dshDebug');
        return /^(1|true|yes|on)$/iu.test(query || '');
      } catch { return false; }
    })();
    const bridgeLog = (event, fields = {}) => {
      if (!bridgeDebugEnabled) return;
      const payload = { at: new Date().toISOString(), side: 'h5', component: 'remote-web-bridge', event, ...fields };
      console.info('[dsh-codingns:tunnel]', payload);
      parent.postMessage({ kind: 'dsh-web-debug', event, fields: payload }, '*');
    };
    const pending = new Map();
    // RPC、WebSocket 和远程 stream 必须使用各自的 ID 空间；资源 fetch
    // 不能改变 WebSocket 的 ID，否则 ws.open 与 ws.send 会指向不同 key。
    let nextCallId = 0;
    let nextSocketId = 0;
    let nextStreamId = 0;
    let remoteLoadChain = Promise.resolve();
    const call = (kind, input, body, explicitId) => new Promise((resolve, reject) => {
      const id = explicitId || String(++nextCallId);
      pending.set(id, { resolve, reject });
      bridgeLog('bridge.call', { kind, id, path: input && typeof input.path === 'string' ? input.path : undefined });
      parent.postMessage({ kind, id, input, body }, '*');
    });
    // srcdoc 的 location.href 是 about:srcdoc，不能作为相对 URL 的基址。
    // prepareBootHtml 已写入固定 base，所有资源解析必须以 document.baseURI 为准。
    const resourceBase = () => document.baseURI && document.baseURI !== 'about:srcdoc' ? document.baseURI : 'https://dsh.remote.invalid/';
    const isRemoteResource = (value) => {
      try {
        const parsed = new URL(value, resourceBase());
        return parsed.protocol !== 'blob:' && (parsed.origin === location.origin || parsed.origin === 'null' || parsed.origin === 'https://dsh.remote.invalid');
      } catch {
        return false;
      }
    };
    const remotePath = (value) => {
      const parsed = new URL(value, resourceBase());
      return parsed.pathname + parsed.search;
    };
    const resourceAttribute = (node, attribute) => node && (node.getAttribute('data-dsh-bridge-source') || node.getAttribute(attribute) || node[attribute] || '');
    const isRemoteScript = (node) => node && node.nodeType === 1 && node.tagName === 'SCRIPT' && node.getAttribute('data-dsh-bridge-loaded') !== '1' && isRemoteResource(resourceAttribute(node, 'src'));
    const isRemoteStyle = (node) => node && node.nodeType === 1 && node.tagName === 'LINK' && (node.getAttribute('rel') || '').toLowerCase() === 'stylesheet' && node.getAttribute('data-dsh-bridge-loaded') !== '1' && isRemoteResource(resourceAttribute(node, 'href'));
    const queueRemoteNode = (parentNode, node, beforeNode, kind, attribute) => {
      const source = resourceAttribute(node, attribute);
      const onload = node.onload;
      const onerror = node.onerror;
      remoteLoadChain = remoteLoadChain.then(async () => {
        const response = await call(kind, { path: remotePath(source) });
        if (!response || typeof response.url !== 'string') throw new Error('远程资源加载失败');
        // 原地复用节点，保留 loader 通过 addEventListener 注册的 load/error 监听器。
        // cloneNode 只复制属性，不复制监听器，会让 client-modules 永远等待。
        node.removeAttribute('data-dsh-bridge-source');
        node.setAttribute('data-dsh-bridge-loaded', '1');
        node.setAttribute(attribute, response.url);
        if (beforeNode) nativeInsertBefore.call(parentNode, node, beforeNode);
        else nativeAppendChild.call(parentNode, node);
      }).catch((error) => {
        console.error('[dsh-codingns] remote resource load failed', error);
        try {
          if (typeof onerror === 'function') onerror.call(node, error);
          else node.dispatchEvent(new Event('error'));
        } catch {}
      });
      return node;
    };
    const nativeAppendChild = Node.prototype.appendChild;
    const nativeInsertBefore = Node.prototype.insertBefore;
    const nativeRemoveChild = Node.prototype.removeChild;
    const nativeAppend = Element.prototype.append;
    const nativePrepend = Element.prototype.prepend;
    const nativeFragmentAppend = DocumentFragment.prototype.append;
    const nativeFragmentPrepend = DocumentFragment.prototype.prepend;
    const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    const nativeReplaceChildren = Element.prototype.replaceChildren;
    const nativeDocumentWrite = Document.prototype.write;
    const nativeDocumentWriteln = Document.prototype.writeln;
    const scriptSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const linkHrefDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
    if (scriptSrcDescriptor?.set && scriptSrcDescriptor.get) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        get() { return this.getAttribute('data-dsh-bridge-source') || scriptSrcDescriptor.get.call(this); },
        set(value) {
          const source = String(value);
          if (isRemoteResource(source)) {
            this.setAttribute('data-dsh-bridge-source', source);
            scriptSrcDescriptor.set.call(this, 'about:blank');
          } else scriptSrcDescriptor.set.call(this, value);
        },
      });
    }
    if (linkHrefDescriptor?.set && linkHrefDescriptor.get) {
      Object.defineProperty(HTMLLinkElement.prototype, 'href', {
        configurable: true,
        get() { return this.getAttribute('data-dsh-bridge-source') || linkHrefDescriptor.get.call(this); },
        set(value) {
          const source = String(value);
          if (isRemoteResource(source)) {
            this.setAttribute('data-dsh-bridge-source', source);
            linkHrefDescriptor.set.call(this, 'about:blank');
          } else linkHrefDescriptor.set.call(this, value);
        },
      });
    }
    const queueFragmentResources = (parentNode, fragment) => {
      if (!fragment || fragment.nodeType !== 11 || !fragment.querySelectorAll) return false;
      const resources = [...fragment.querySelectorAll('script[src],link[rel="stylesheet"][href]')].filter((node) => isRemoteScript(node) || isRemoteStyle(node));
      if (resources.length === 0) return false;
      for (const node of resources) {
        const resourceParent = node.parentNode;
        if (!resourceParent) continue;
        nativeRemoveChild.call(resourceParent, node);
        queueRemoteNode(parentNode, node, null, isRemoteScript(node) ? 'script' : 'style', isRemoteScript(node) ? 'src' : 'href');
      }
      return true;
    };
    Node.prototype.appendChild = function(node) {
      if (isRemoteScript(node)) return queueRemoteNode(this, node, null, 'script', 'src');
      if (isRemoteStyle(node)) return queueRemoteNode(this, node, null, 'style', 'href');
      return nativeAppendChild.call(this, node);
    };
    Node.prototype.insertBefore = function(node, beforeNode) {
      if (isRemoteScript(node)) return queueRemoteNode(this, node, beforeNode, 'script', 'src');
      if (isRemoteStyle(node)) return queueRemoteNode(this, node, beforeNode, 'style', 'href');
      return nativeInsertBefore.call(this, node, beforeNode);
    };
    Element.prototype.append = function(...nodes) {
      for (const node of nodes) {
        if (isRemoteScript(node)) queueRemoteNode(this, node, null, 'script', 'src');
        else if (isRemoteStyle(node)) queueRemoteNode(this, node, null, 'style', 'href');
        else if (queueFragmentResources(this, node)) nativeAppend.call(this, node);
        else if (typeof node === 'string' && /<(?:script|link)\b/iu.test(node)) {
          const template = document.createElement('template');
          template.innerHTML = node;
          for (const child of [...template.content.childNodes]) {
            if (isRemoteScript(child)) queueRemoteNode(this, child, null, 'script', 'src');
            else if (isRemoteStyle(child)) queueRemoteNode(this, child, null, 'style', 'href');
            else nativeAppendChild.call(this, child);
          }
        }
        else nativeAppend.call(this, node);
      }
    };
    Element.prototype.prepend = function(...nodes) {
      for (const node of [...nodes].reverse()) {
        if (isRemoteScript(node)) queueRemoteNode(this, node, this.firstChild, 'script', 'src');
        else if (isRemoteStyle(node)) queueRemoteNode(this, node, this.firstChild, 'style', 'href');
        else if (queueFragmentResources(this, node)) nativePrepend.call(this, node);
        else if (typeof node === 'string' && /<(?:script|link)\b/iu.test(node)) {
          const template = document.createElement('template');
          template.innerHTML = node;
          for (const child of [...template.content.childNodes].reverse()) {
            if (isRemoteScript(child)) queueRemoteNode(this, child, this.firstChild, 'script', 'src');
            else if (isRemoteStyle(child)) queueRemoteNode(this, child, this.firstChild, 'style', 'href');
            else nativeInsertBefore.call(this, child, this.firstChild);
          }
        }
        else nativePrepend.call(this, node);
      }
    };
    // 部分插件 loader 先把 script 放进 DocumentFragment，再一次性挂到 head。
    // DocumentFragment 不继承 Element.prototype，这条路径必须单独接管。
    DocumentFragment.prototype.append = function(...nodes) {
      for (const node of nodes) {
        if (isRemoteScript(node)) queueRemoteNode(this, node, null, 'script', 'src');
        else if (isRemoteStyle(node)) queueRemoteNode(this, node, null, 'style', 'href');
        else if (queueFragmentResources(this, node)) nativeFragmentAppend.call(this, node);
        else nativeFragmentAppend.call(this, node);
      }
    };
    DocumentFragment.prototype.prepend = function(...nodes) {
      for (const node of [...nodes].reverse()) {
        if (isRemoteScript(node)) queueRemoteNode(this, node, this.firstChild, 'script', 'src');
        else if (isRemoteStyle(node)) queueRemoteNode(this, node, this.firstChild, 'style', 'href');
        else if (queueFragmentResources(this, node)) nativeFragmentPrepend.call(this, node);
        else nativeFragmentPrepend.call(this, node);
      }
    };
    Element.prototype.replaceChildren = function(...nodes) {
      const remoteNodes = nodes.filter((node) => isRemoteScript(node) || isRemoteStyle(node));
      nativeReplaceChildren.call(this, ...nodes.filter((node) => !isRemoteScript(node) && !isRemoteStyle(node)));
      for (const node of remoteNodes) queueRemoteNode(this, node, null, isRemoteScript(node) ? 'script' : 'style', isRemoteScript(node) ? 'src' : 'href');
    };
    Element.prototype.insertAdjacentHTML = function(position, html) {
      if (typeof html !== 'string' || !/(?:<script\b|<link\b)/iu.test(html)) {
        return nativeInsertAdjacentHTML.call(this, position, html);
      }
      const template = document.createElement('template');
      template.innerHTML = html;
      const target = position === 'beforebegin' || position === 'afterend' ? this.parentNode : this;
      if (!target) return nativeInsertAdjacentHTML.call(this, position, html);
      const children = [...template.content.childNodes];
      const ordered = position === 'afterbegin' ? children.reverse() : children;
      for (const child of ordered) {
        if (isRemoteScript(child)) {
          queueRemoteNode(target, child, position === 'beforebegin' ? this : position === 'afterbegin' ? this.firstChild : null, 'script', 'src');
        } else if (isRemoteStyle(child)) {
          queueRemoteNode(target, child, position === 'beforebegin' ? this : position === 'afterbegin' ? this.firstChild : null, 'style', 'href');
        } else if (position === 'beforebegin') nativeInsertBefore.call(target, child, this);
        else if (position === 'afterend') nativeInsertBefore.call(target, child, this.nextSibling);
        else if (position === 'afterbegin') nativeInsertBefore.call(target, child, this.firstChild);
        else nativeAppendChild.call(target, child);
      }
    };
    const writeRemoteMarkup = (documentNode, html) => {
      if (typeof html !== 'string' || !/(?:<script\b|<link\b)/iu.test(html)) return false;
      const template = documentNode.createElement('template');
      template.innerHTML = html;
      const parent = documentNode.head || documentNode.documentElement;
      for (const child of [...template.content.childNodes]) {
        if (isRemoteScript(child)) queueRemoteNode(parent, child, null, 'script', 'src');
        else if (isRemoteStyle(child)) queueRemoteNode(parent, child, null, 'style', 'href');
        else nativeAppendChild.call(parent, child);
      }
      return true;
    };
    Document.prototype.write = function(html) {
      if (!writeRemoteMarkup(this, html)) nativeDocumentWrite.call(this, html);
    };
    Document.prototype.writeln = function(html) {
      if (!writeRemoteMarkup(this, html)) nativeDocumentWriteln.call(this, html);
    };
    const handleAddedNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (isRemoteScript(node) || isRemoteStyle(node)) {
        const parentNode = node.parentNode;
        if (!parentNode) return;
        nativeRemoveChild.call(parentNode, node);
        queueRemoteNode(parentNode, node, null, isRemoteScript(node) ? 'script' : 'style', isRemoteScript(node) ? 'src' : 'href');
      }
      if (node.querySelectorAll) for (const child of node.querySelectorAll('script[src],link[rel="stylesheet"][href]')) handleAddedNode(child);
    };
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) handleAddedNode(node);
    }).observe(document, { childList: true, subtree: true });
    // 远程模式的 DSH Web 使用 memory persistence，欢迎声明在每次 iframe
    // 重建时都会重新出现。通过点击 DSH 自己的确认按钮关闭它，既能让
    // DSH 完成状态更新，也能触发 OnboardingModal 恢复 #root.inert。
    const welcomeTitles = new Set(['内测声明', 'Welcome Notice', 'Beta Notice', 'Internal Testing Notice']);
    const welcomeButtons = new Set(['继续', 'Continue']);
    const normalizeText = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const welcomeTitle = (root) => normalizeText(root.querySelector('h1,h2,h3,[role="heading"],[data-testid="modal-title"]')?.textContent || root.getAttribute('aria-label'));
    const welcomeRoots = () => {
      const roots = new Set(document.querySelectorAll('[role="dialog"],dialog,[class*="onboardingOverlay"]'));
      // 兼容没有 role/aria-modal 的旧版 Modal：从标题向上找到包含按钮的最近容器。
      for (const heading of document.querySelectorAll('h1,h2,h3,[role="heading"]')) {
        if (!welcomeTitles.has(normalizeText(heading.textContent))) continue;
        let root = heading;
        for (let depth = 0; depth < 8 && root; depth += 1, root = root.parentElement) {
          if (root.querySelector('button')) {
            roots.add(root);
            break;
          }
        }
      }
      return roots;
    };
    const hideWelcomeRoot = (root) => {
      root.setAttribute('hidden', '');
      root.setAttribute('aria-hidden', 'true');
      if (root instanceof HTMLElement) root.style.display = 'none';
      // CSS 隐藏不会触发 DSH OnboardingModal 的 cleanup，必须同步解除 inert。
      const appRoot = document.getElementById('root');
      if (appRoot) appRoot.inert = false;
    };
    const acknowledgeRemoteWelcome = () => {
      for (const root of welcomeRoots()) {
        if (!welcomeTitles.has(welcomeTitle(root))) continue;
        const button = [...root.querySelectorAll('button')].find((candidate) => !candidate.disabled && welcomeButtons.has(normalizeText(candidate.textContent)));
        if (!button || button.dataset.dshCodingnsAutoAcknowledged === '1') {
          if (!button) hideWelcomeRoot(root);
          continue;
        }
        button.dataset.dshCodingnsAutoAcknowledged = '1';
        // 等待当前 React 提交完成后再触发事件，确保 onClick 已经绑定。
        queueMicrotask(() => {
          if (button.isConnected && !button.disabled) button.click();
          setTimeout(() => {
            // 某些构建把 React 事件委托绑定放在 effect 中，首个 click 可能早于委托注册；
            // 若弹窗仍在 DOM 中，补一次点击，仍未关闭则直接隐藏并解除 inert。
            if (button.isConnected && !button.disabled) button.click();
            if (root.isConnected) hideWelcomeRoot(root);
          }, 0);
        });
      }
    };
    acknowledgeRemoteWelcome();
    new MutationObserver(acknowledgeRemoteWelcome).observe(document, { childList: true, subtree: true });
    addEventListener('message', (event) => {
      const value = event.data;
      if (!value || value.kind === undefined) return;
      if (value.kind === 'dsh-web-response') {
        const item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id);
        if (value.ok === false) item.reject(new Error(value.error || 'Remote DSH Web 请求失败'));
        else item.resolve(value);
      }
      if (value.kind === 'dsh-web-event') {
        const item = pending.get(value.id);
        if (item && value.type === 'error') item.reject(new Error(value.body || 'Remote DSH WebSocket 失败'));
        const target = window.__dshRemoteSockets && window.__dshRemoteSockets.get(value.id);
        if (target) {
          if (value.type === 'message') target._emit?.('message', { data: value.body });
          if (value.type === 'close') {
            target.readyState = 3;
            target._emit?.('close', new CloseEvent('close'));
          }
          if (value.type === 'error') target._emit?.('error', new Event('error'));
        }
      }
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      // DSH client-connection 使用 URL 对象调用 fetch；Request 则提供 url。
      // 两者都必须保留原始路径，否则会把请求错误地转成 /undefined。
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === 'string'
            ? input.url
            : String(input);
      const parsed = new URL(url, resourceBase());
      // DSH 官方 client-connection 使用 http://dsh.internal 作为逻辑 API 基址；
      // 这是 iframe 内的虚拟地址，必须和 remote.invalid 一样转入 Web Tunnel，
      // 不能让浏览器按真实网络请求处理并被 CSP 拦截。
      if (parsed.origin === location.origin || parsed.origin === 'null' || parsed.origin === 'https://dsh.remote.invalid' || parsed.origin === 'http://dsh.internal') {
        const request = typeof input === 'string' ? undefined : input;
        const method = init?.method ?? request?.method;
        const headers = init?.headers ?? request?.headers;
        let body = typeof init?.body === 'string' ? init.body : undefined;
        if (body === undefined && init?.body instanceof URLSearchParams) body = init.body.toString();
        if (body === undefined && init === undefined && request && request.method !== 'GET' && request.method !== 'HEAD') {
          body = await request.clone().text();
        }
        const response = await call('fetch', { path: parsed.pathname + parsed.search, method, headers: headers ? [...new Headers(headers).entries()] : undefined }, body);
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      return originalFetch(input, init);
    };
    window.__dshRemoteSockets = new Map();
    const RemoteWebSocket = class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = RemoteWebSocket.CONNECTING;
        this._listeners = new Map();
        window.__dshRemoteSockets.set(this._id = String(++nextSocketId), this);
        bridgeLog('bridge.ws.open', { id: this._id, path: new URL(this.url, resourceBase()).pathname });
        call('ws.open', { path: new URL(this.url, resourceBase()).pathname }, undefined, this._id).then(() => {
          if (this.readyState !== RemoteWebSocket.CONNECTING) return;
          this.readyState = RemoteWebSocket.OPEN;
          bridgeLog('bridge.ws.open.response', { id: this._id });
          this._emit('open', new Event('open'));
        }).catch((error) => {
          bridgeLog('bridge.ws.open.error', { id: this._id, error: error instanceof Error ? error.message : String(error) });
          this.readyState = RemoteWebSocket.CLOSED;
          this._emit('error', new Error(error));
        });
      }
      send(value) {
        if (this.readyState !== RemoteWebSocket.OPEN) throw new Error('WebSocket is not open');
        bridgeLog('bridge.ws.send', { id: this._id, bytes: typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value?.byteLength, encoding: typeof value === 'string' ? 'text' : 'binary' });
        parent.postMessage({ kind: 'ws.send', id: this._id, body: typeof value === 'string' ? value : value }, '*');
      }
      close(code, reason) {
        if (this.readyState === RemoteWebSocket.CLOSING || this.readyState === RemoteWebSocket.CLOSED) return;
        this.readyState = RemoteWebSocket.CLOSING;
        bridgeLog('bridge.ws.close', { id: this._id, code: code || 1000 });
        parent.postMessage({ kind: 'ws.close', id: this._id, input: { code, reason } }, '*');
        this.readyState = RemoteWebSocket.CLOSED;
        this._emit('close', new CloseEvent('close', { code: code || 1000, reason: reason || '' }));
      }
      addEventListener(type, listener, options) {
        const listeners = this._listeners.get(type) || [];
        if (!listeners.some((item) => item.listener === listener)) listeners.push({ listener, once: options?.once === true });
        this._listeners.set(type, listeners);
      }
      removeEventListener(type, listener) {
        const listeners = this._listeners.get(type) || [];
        this._listeners.set(type, listeners.filter((item) => item.listener !== listener));
      }
      _emit(type, event) {
        const listeners = [...(this._listeners.get(type) || [])];
        for (const item of listeners) {
          try { item.listener.call(this, event); } catch (error) { setTimeout(() => { throw error; }, 0); }
          if (item.once) this.removeEventListener(type, item.listener);
        }
        const handler = this['on' + type];
        if (typeof handler === 'function') handler.call(this, event);
      }
    };
    window.WebSocket = RemoteWebSocket;
    const openRemoteStream = (endpoint, payload, signal) => {
      const streamId = 'remote_' + String(++nextStreamId) + '_' + Math.random().toString(36).slice(2);
      return (async function*() {
        const socket = new RemoteWebSocket(new URL('/api/remote.mux', resourceBase()).href);
        const frames = [];
        let wake;
        let ended = false;
        let failure;
        const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
        const onMessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data));
            if (!frame || frame.streamId !== streamId) return;
            if (frame.type === 'end') ended = true;
            else if (frame.type === 'error') failure = new Error(frame.error?.message || '远程 DSH Stream 失败');
            else if (frame.type === 'item') frames.push(frame.value);
            notify();
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            notify();
          }
        };
        const onError = () => { failure = new Error('远程 DSH Stream WebSocket 失败'); notify(); };
        const onAbort = () => { failure = signal.reason instanceof Error ? signal.reason : new Error('远程 DSH Stream 已取消'); notify(); };
        socket.addEventListener('message', onMessage);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await new Promise((resolve, reject) => {
            const opened = () => resolve(undefined);
            const failed = () => reject(new Error('远程 DSH Stream WebSocket 打开失败'));
            socket.addEventListener('open', opened, { once: true });
            socket.addEventListener('error', failed, { once: true });
            });
          socket.addEventListener('error', onError);
          signal?.throwIfAborted();
          socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
          while (!ended) {
            if (failure) throw failure;
            if (frames.length === 0) await new Promise((resolve) => { wake = resolve; });
            while (frames.length > 0) yield frames.shift();
          }
          if (failure) throw failure;
        } finally {
          signal?.removeEventListener('abort', onAbort);
          socket.close(1000, 'stream closed');
        }
      })();
    };
    const parentTransport = (() => {
      try { return parent.__DSH_CODINGNS_REMOTE_TRANSPORT__; } catch { return undefined; }
    })();
    globalThis.__DSH_TRANSPORT__ = {
      fetch: window.fetch.bind(window),
      openStream: openRemoteStream,
      // 该 iframe 的所有 DSH 请求都经由已认证的 CodingNS 隧道回到选定 Host。
      // 必须声明 Host 所有权，否则 ui-settings 会把远程页面降级为 memory
      // 模式，原生“模型”页无法读取 settings provider。
      ownsHost: true,
      generation: parentTransport?.getGeneration?.bind(parentTransport),
      onGenerationChange: parentTransport?.onGenerationChange?.bind(parentTransport),
      reconnect: parentTransport?.reconnect?.bind(parentTransport),
      close: parentTransport?.close?.bind(parentTransport),
    };
    globalThis.__DSH_CODINGNS_DEBUG__ = (event, fields = {}) => {
      bridgeLog('client.' + String(event), fields);
    };
    const NativeEventSource = globalThis.EventSource;
    class RemoteEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.withCredentials = false;
        this._listeners = new Map();
        const path = new URL(this.url, resourceBase()).pathname;
        // HMR 的 /plugins/events 只负责开发期热更新；远程 Web 通过 Tunnel
        // 运行时没有可用的 SSE 端点，模拟已打开的空事件源即可避免它触发
        // DSH 主连接的重试逻辑。其它 EventSource 仍交给原生实现。
        if (path === '/plugins/events') {
          queueMicrotask(() => {
            this.readyState = 1;
            this._emit('open', new Event('open'));
          });
          return;
        }
        if (typeof NativeEventSource !== 'function') throw new Error('远程 DSH Web 不支持 EventSource');
        this._native = new NativeEventSource(this.url);
        this.readyState = this._native.readyState;
      }
      addEventListener(type, listener) {
        const list = this._listeners.get(type) || [];
        list.push(listener);
        this._listeners.set(type, list);
        this._native?.addEventListener(type, listener);
      }
      removeEventListener(type, listener) {
        const list = this._listeners.get(type) || [];
        this._listeners.set(type, list.filter((item) => item !== listener));
        this._native?.removeEventListener(type, listener);
      }
      _emit(type, event) {
        for (const listener of this._listeners.get(type) || []) listener.call(this, event);
        const handler = this['on' + type];
        if (typeof handler === 'function') handler.call(this, event);
      }
      close() {
        this.readyState = 2;
        this._native?.close();
      }
    }
    globalThis.EventSource = RemoteEventSource;
  })();`
}

function resolveRemotePath(value: string): string {
  const parsed = new URL(value, 'https://dsh.remote.invalid')
  if (parsed.origin !== 'https://dsh.remote.invalid' || parsed.pathname.includes('..')) throw new Error('远程 DSH Web 路径无效')
  return parsed.pathname + parsed.search
}

/**
 * DSH Web 原本的 CSP 面向真实站点；srcdoc 中的插件代码已经被搬到 Blob，
 * 动态请求也由父页面 Tunnel 代理，因此必须把不再成立的站点限制换成
 * 适用于沙箱 iframe 的策略。connect-src 保持关闭，防止页面绕过 bridge 直连。
 */
function relaxRemoteContentSecurityPolicy(documentValue: Document): void {
  const policy = "default-src 'self' blob: data:; script-src 'self' blob: data: 'unsafe-inline' 'unsafe-eval'; style-src 'self' blob: data: 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'none'; frame-src 'self' blob: data:"
  for (const node of documentValue.querySelectorAll<HTMLMetaElement>('meta[http-equiv]')) {
    if ((node.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-security-policy') node.setAttribute('content', policy)
  }
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  throw new TypeError('远程 WebSocket 消息必须是二进制或字符串')
}

function decodeText(value: Uint8Array): string {
  if (!(value instanceof Uint8Array)) throw new TypeError('远程 DSH Web 资源必须是二进制')
  return new TextDecoder().decode(value)
}

function collectRelativeReferences(source: string, suffix: RegExp): readonly string[] {
  const found = new Set<string>()
  const pattern = /["'`]((?:\.\.?\/)[^"'`]+)["'`]/gu
  for (const match of source.matchAll(pattern)) {
    const reference = match[1]
    if (reference !== undefined && suffix.test(reference)) found.add(reference)
  }
  return [...found]
}

function collectCssReferences(source: string, suffix: RegExp): readonly string[] {
  const found = new Set<string>()
  const pattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'\s]+))\s*\)/gu
  for (const match of source.matchAll(pattern)) {
    const reference = match[1] ?? match[2] ?? match[3]
    if (reference?.startsWith('./') === true || reference?.startsWith('../') === true) {
      if (suffix.test(reference)) found.add(reference)
    }
  }
  return [...found]
}

function resolveRelativeAssetPath(sourcePath: string, reference: string): string {
  const resolved = new URL(reference, `https://dsh.remote.invalid${sourcePath}`)
  return resolveRemotePath(resolved.pathname + resolved.search)
}

function contentTypeForPath(path: string): string {
  if (/\.woff2?(?:$|\?)/u.test(path)) return 'font/woff'
  if (/\.ttf(?:$|\?)/u.test(path)) return 'font/ttf'
  if (/\.svg(?:$|\?)/u.test(path)) return 'image/svg+xml'
  if (/\.png(?:$|\?)/u.test(path)) return 'image/png'
  return 'application/octet-stream'
}

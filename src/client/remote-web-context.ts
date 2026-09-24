import type { DshCodingNsTransport } from '../transport/dsh-transport.js'

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
  private iframeValue: HTMLIFrameElement | undefined
  private sessionIdValue: string | undefined
  private disposed = false
  private readonly onMessageBound = (event: MessageEvent<unknown>) => { void this.onMessage(event) }

  constructor(private readonly options: RemoteDshWebContextOptions) {
    if (typeof document === 'undefined') throw new Error('Remote DSH Web Context 只能运行在浏览器')
  }

  get iframe(): HTMLIFrameElement | undefined { return this.iframeValue }
  get sessionId(): string | undefined { return this.sessionIdValue }

  async open(signal?: AbortSignal): Promise<void> {
    this.ensureOpen()
    window.addEventListener('message', this.onMessageBound)
    const session = await this.options.transport.webRequest<{ sessionId: string; dshVersion: string }>('web.session.open', {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    }, signal)
    this.sessionIdValue = session.sessionId
    const boot = await this.options.transport.webRequest<RemoteDshWebBoot>('web.boot.get', { sessionId: session.sessionId }, signal)
    const iframe = document.createElement('iframe')
    iframe.className = 'dsh-remote-web-context'
    iframe.setAttribute('title', 'Remote DSH Web')
    iframe.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-scripts')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.border = '0'
    iframe.srcdoc = await this.prepareBootHtml(boot, signal)
    this.options.container.replaceChildren(iframe)
    this.iframeValue = iframe
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessageBound)
    for (const streamId of this.sockets.values()) this.options.transport.closeWebStream(streamId)
    this.sockets.clear()
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
    this.sessionIdValue = undefined
  }

  private async prepareBootHtml(boot: RemoteDshWebBoot, signal?: AbortSignal): Promise<string> {
    const parser = new DOMParser()
    const documentValue = parser.parseFromString(boot.html, 'text/html')
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
      if (rel === 'modulepreload' || rel === 'manifest' || rel === 'icon') node.remove()
    }
    await Promise.all([
      ...scriptNodes.map(async (node) => {
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
      const references = collectRelativeReferences(source, /\.(?:js)(?:\?[^\s"'`)]*)?$/u)
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
    if (this.disposed || !this.iframeValue || event.source !== this.iframeValue.contentWindow) return
    if (!isRecord(event.data) || typeof event.data.kind !== 'string' || typeof event.data.id !== 'string') return
    const message = event.data
    try {
      if (message.kind === 'fetch') {
        const input = isRecord(message.input) ? message.input : {}
        const path = resolveRemotePath(typeof input.path === 'string' ? input.path : '/')
        const response = path.startsWith('/assets/') || path.startsWith('/plugins/')
          ? { status: 200, headers: [['content-type', 'application/octet-stream']], body: await this.options.transport.webRequest<Uint8Array>('web.asset.get', { sessionId: this.sessionIdValue, path }) }
          : await this.options.transport.webRequest<{ status: number; headers: [string, string][]; body: string }>('web.request', { sessionId: this.sessionIdValue, path, method: typeof input.method === 'string' ? input.method : 'GET', ...(Array.isArray(input.headers) ? { headers: input.headers } : {}), ...(typeof input.body === 'string' ? { body: input.body } : {}) })
        this.postResponse(message.id, { ok: true, status: response.status, headers: response.headers, body: response.body instanceof Uint8Array ? response.body.buffer : response.body })
        return
      }
      if (message.kind === 'ws.open') {
        const input = isRecord(message.input) ? message.input : {}
        const opened = this.options.transport.openWebStreamWithId('web.ws.open', { sessionId: this.sessionIdValue, path: resolveRemotePath(typeof input.path === 'string' ? input.path : '/') })
        this.sockets.set(message.id, opened.streamId)
        void this.consumeSocket(message.id, opened.streamId, opened.stream)
        this.postResponse(message.id, { ok: true })
        return
      }
      if (message.kind === 'ws.send') {
        const streamId = this.sockets.get(message.id)
        if (!streamId) throw new Error('Remote DSH WebSocket 不存在')
        const body = typeof message.body === 'string' ? new TextEncoder().encode(message.body) : toBytes(message.body)
        this.options.transport.sendWebStream(streamId, 'web.ws.data', body, { ...(typeof message.body === 'string' ? { encoding: 'text' } : { binary: true }) })
        return
      }
      if (message.kind === 'ws.close') {
        const streamId = this.sockets.get(message.id)
        if (streamId) this.options.transport.closeWebStream(streamId)
        this.sockets.delete(message.id)
      }
    } catch (error) {
      this.postResponse(message.id, { ok: false, error: error instanceof Error ? error.message : 'Remote DSH Web 请求失败' })
    }
  }

  private async consumeSocket(id: string, streamId: string, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      let opened = false
      for await (const value of stream) {
        if (!opened) {
          opened = true
          if (isRecord(value) && value.opened === true) continue
        }
        if (value instanceof Uint8Array) this.postEvent(id, 'message', value.buffer)
        else this.postEvent(id, 'message', typeof value === 'string' ? value : JSON.stringify(value))
      }
      this.postEvent(id, 'close', undefined)
    } catch (error) {
      this.postEvent(id, 'error', error instanceof Error ? error.message : 'Remote DSH WebSocket 流失败')
    } finally {
      if (this.sockets.get(id) === streamId) this.sockets.delete(id)
    }
  }

  private postResponse(id: string, value: Record<string, unknown>): void {
    this.iframeValue?.contentWindow?.postMessage({ kind: 'dsh-web-response', id, ...value }, '*')
  }

  private postEvent(id: string, type: string, body: unknown): void {
    this.iframeValue?.contentWindow?.postMessage({ kind: 'dsh-web-event', id, type, body }, '*')
  }

  private ensureOpen(): void { if (this.disposed) throw new Error('Remote DSH Web Context 已关闭') }
}

function createBridgeScript(): string {
  return `(() => {
    const pending = new Map();
    let nextId = 0;
    const call = (kind, input, body) => new Promise((resolve, reject) => {
      const id = String(++nextId);
      pending.set(id, { resolve, reject });
      parent.postMessage({ kind, id, input, body }, '*');
    });
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
          if (value.type === 'message') target.onmessage && target.onmessage({ data: value.body });
          if (value.type === 'close') { target.readyState = 3; target.onclose && target.onclose(new CloseEvent('close')); }
          if (value.type === 'error') target.onerror && target.onerror(new Event('error'));
        }
      }
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const parsed = new URL(url, location.href);
      if (parsed.origin === location.origin || parsed.origin === 'null' || parsed.origin === 'https://dsh.remote.invalid') {
        const response = await call('fetch', { path: parsed.pathname + parsed.search, method: init && init.method, headers: init && [...new Headers(init.headers).entries()] }, typeof init?.body === 'string' ? init.body : undefined);
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      return originalFetch(input, init);
    };
    window.__dshRemoteSockets = new Map();
    window.WebSocket = class RemoteWebSocket {
      constructor(url) { this.url = String(url); this.readyState = 0; window.__dshRemoteSockets.set(this._id = String(++nextId), this); call('ws.open', { path: new URL(this.url, location.href).pathname }).then(() => { this.readyState = 1; this.onopen && this.onopen(new Event('open')); }).catch((error) => { this.readyState = 3; this.onerror && this.onerror(new Error(error)); }); }
      send(value) { if (this.readyState !== 1) throw new Error('WebSocket is not open'); parent.postMessage({ kind: 'ws.send', id: this._id, body: typeof value === 'string' ? value : value }, '*'); }
      close(code, reason) { this.readyState = 2; parent.postMessage({ kind: 'ws.close', id: this._id, input: { code, reason } }, '*'); this.readyState = 3; this.onclose && this.onclose(new CloseEvent('close', { code: code || 1000, reason: reason || '' })); }
      addEventListener(type, listener) { this['on' + type] = listener; }
      removeEventListener(type, listener) { if (this['on' + type] === listener) this['on' + type] = null; }
    };
  })();`
}

function resolveRemotePath(value: string): string {
  const parsed = new URL(value, 'https://dsh.remote.invalid')
  if (parsed.origin !== 'https://dsh.remote.invalid' || parsed.pathname.includes('..')) throw new Error('远程 DSH Web 路径无效')
  return parsed.pathname + parsed.search
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

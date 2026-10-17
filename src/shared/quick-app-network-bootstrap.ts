/** Browser-side fetch/XHR shim. Kept free of host imports because its source is copied into the sandbox document. */

export function quickAppPageEgressUrl(pageHref: string): string {
  const page = new URL(pageHref)
  const base = page.pathname.match(/^\/__codingns\/quick-apps\/[^/]+\//)
  const prefix = base ? base[0] : page.pathname.replace(/[^/]*$/u, '')
  return new URL(`${prefix}__quickapp/egress`, pageHref).href
}

export function quickAppRequestUsesEgress(pageHref: string, requestUrl: string): boolean {
  const page = new URL(pageHref)
  const target = new URL(requestUrl, pageHref)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  return target.host !== page.host
}

export function quickAppNetworkSource(): string {
  return [quickAppPageEgressUrl, quickAppRequestUsesEgress, quickAppNetworkInstall].map(item => item.toString()).join('\n')
}

/** Runs before any application script, including when the iframe loads the file directly. */
export function quickAppPreparedHtml(html: string): string {
  return `<script>${quickAppNetworkSource()}\nquickAppNetworkInstall();</script>${html}`
}

export function quickAppNetworkBootstrap(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quick App</title></head><body><script>${quickAppNetworkSource()}
${quickAppNetworkBootstrapRuntime.toString()}
quickAppNetworkBootstrapRuntime();</script></body></html>`
}

function quickAppNetworkBootstrapRuntime(): void {
  const source = fetch(location.href, { headers: { Accept: 'text/html' } }).then(response => {
    if (!response.ok) throw new Error('The application HTML could not be loaded.')
    return response.text()
  })
  void source.then(html => {
    quickAppNetworkInstall()
    document.open()
    document.write(html)
    document.close()
  }).catch(error => {
    const message = document.createElement('p')
    message.setAttribute('role', 'alert')
    message.textContent = error instanceof Error ? error.message : 'Application network initialization failed.'
    document.body.replaceChildren(message)
  })
}

export function quickAppNetworkInstall(): void {
  const current = globalThis.fetch as typeof globalThis.fetch & { __quickAppEgress?: boolean }
  if (current.__quickAppEgress && (XMLHttpRequest.prototype.open as typeof XMLHttpRequest.prototype.open & { __quickAppEgress?: boolean }).__quickAppEgress) return
  const nativeFetch = (current.__quickAppEgress ? current : globalThis.fetch).bind(globalThis)
  const endpoint = quickAppPageEgressUrl(location.href)
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader
  const allowed = (name: string) => name === 'authorization' || name === 'content-type' || name === 'accept' || name === 'accept-language'
  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192) as unknown as number[])
    return btoa(binary)
  }
  const proxy = async (method: string, url: string, headers: [string, string][], body: BodyInit | null | undefined, signal?: AbortSignal, redirect?: RequestRedirect) => {
    const fields = headers.filter(([name]) => allowed(name))
    const payload: { method: string; url: string; headers: [string, string][]; redirect?: RequestRedirect; body?: string } = { method, url, headers: fields, ...(redirect ? { redirect } : {}) }
    if (body != null) {
      const probe = new Response(body)
      const type = probe.headers.get('content-type')
      if (type && !fields.some(([name]) => name === 'content-type')) fields.push(['content-type', type])
      const bytes = new Uint8Array(await probe.arrayBuffer())
      if (bytes.byteLength) payload.body = bytesToBase64(bytes)
    }
    return nativeFetch(endpoint, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: JSON.stringify(payload), ...(signal ? { signal } : {}) })
  }
  const shim = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!quickAppRequestUsesEgress(location.href, request.url)) return nativeFetch(request)
    const headers: [string, string][] = []
    request.headers.forEach((value, key) => headers.push([key, value]))
    return proxy(request.method, request.url, headers, request.body, request.signal, request.redirect)
  }, { __quickAppEgress: true as const })
  if (!current.__quickAppEgress) globalThis.fetch = shim
  if ((XMLHttpRequest.prototype.open as typeof XMLHttpRequest.prototype.open & { __quickAppEgress?: boolean }).__quickAppEgress) return
  XMLHttpRequest.prototype.open = Object.assign(function open(this: XMLHttpRequest, method: string, url: string | URL, async?: boolean) {
    const target = new URL(String(url), location.href)
    Object.defineProperty(this, '__qaEgress', { configurable: true, value: { method: String(method || 'GET').toUpperCase(), url: target.href, headers: [] as [string, string][], async: async !== false } })
    return xhrOpen.call(this, String(method), url, async !== false)
  }, { __quickAppEgress: true as const })
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(this: XMLHttpRequest & { __qaEgress?: { headers: [string, string][] } }, name: string, value: string) {
    this.__qaEgress?.headers.push([String(name).toLowerCase(), String(value)])
    return xhrSetHeader.call(this, name, value)
  }
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest & { __qaEgress?: { method: string; url: string; headers: [string, string][]; async: boolean } }, body?: Document | XMLHttpRequestBodyInit | null) {
    const plan = this.__qaEgress
    if (!plan?.async || !quickAppRequestUsesEgress(location.href, plan.url)) return xhrSend.call(this, body)
    if (body != null && typeof body !== 'string' && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof FormData) && !(body instanceof URLSearchParams)) return xhrSend.call(this, body)
    const controller = new AbortController()
    const abort = this.abort
    this.abort = function abortEgress() { controller.abort(); return abort.call(this) }
    void proxy(plan.method, plan.url, plan.headers, body ?? null, controller.signal, 'follow').then(async response => {
      const bytes = new Uint8Array(await response.arrayBuffer())
      const text = new TextDecoder().decode(bytes)
      const pairs: [string, string][] = []
      response.headers.forEach((value, key) => pairs.push([key, value]))
      const value = this.responseType === 'arraybuffer' ? bytes.buffer : this.responseType === 'blob' ? new Blob([bytes]) : this.responseType === 'json' ? JSON.parse(text || 'null') : text
      const define = (name: string, current: unknown) => Object.defineProperty(this, name, { configurable: true, get: () => current })
      define('readyState', 4); define('status', response.status); define('statusText', response.statusText); define('responseText', text); define('response', value); define('responseURL', response.url)
      this.getAllResponseHeaders = () => pairs.map(([key, header]) => `${key}: ${header}`).join('\r\n')
      this.getResponseHeader = name => pairs.find(([key]) => key === String(name).toLowerCase())?.[1] ?? null
      this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'))
    }).catch(() => { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('loadend')) })
  }
}

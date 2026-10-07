import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 下载器只获取公开 HTTP(S) 数据；每次重定向重新校验，不携带宿主凭据。 */
export class AssistantAvatarRemote {
  constructor(private readonly fetchRemote: typeof fetch = (...args) => fetch(...args),
    private readonly resolveAddresses: (host: string) => Promise<readonly { address: string }[]> = (host) => lookup(host, { all: true })) {}

  async read(source: string, maxBytes: number, signal?: AbortSignal): Promise<{ url: string; bytes: Uint8Array }> {
    let url = source
    const deadline = AbortSignal.timeout(30000)
    const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    for (let redirects = 0; redirects <= 3; redirects++) {
      cancellation.throwIfAborted()
      const target = remoteUrl(url)
      const addresses = await this.resolveAddresses(target.hostname.replace(/^\[|\]$/gu, ''))
      cancellation.throwIfAborted()
      // 常见 TUN 代理给域名返回 198.18/15 的 Fake-IP；保留域名交给代理路由，
      // 不允许用户直接访问这一地址段，真实私网解析仍然拒绝。
      if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address)
        && !(isIP(target.hostname) === 0 && /^198\.(18|19)\./u.test(address)))) throw new TypeError('形象资源必须使用公开网络地址')
      const response = await this.fetchRemote(target.href, { credentials: 'omit', redirect: 'manual', signal: cancellation,
        headers: { Accept: 'application/json, image/*, application/octet-stream', 'User-Agent': 'CodingNS-avatar-installer' } })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (location === null) throw new Error('形象资源重定向缺少地址')
        url = new URL(location, target).href
        continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`avatar_download_http_${response.status}`) }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new TypeError('形象资源超过大小限制') }
      const reader = response.body?.getReader()
      if (reader === undefined) throw new TypeError('形象资源为空')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          cancellation.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maxBytes) throw new TypeError('形象资源超过大小限制')
          chunks.push(chunk.value)
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error }
      finally { reader.releaseLock() }
      if (size === 0) throw new TypeError('形象资源为空')
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return { url: target.href, bytes }
    }
    throw new TypeError('形象资源重定向过多')
  }
  async json(source: string, signal?: AbortSignal): Promise<{ url: string; value: unknown }> {
    const result = await this.read(source, 2 * 1024 * 1024, signal)
    return { url: result.url, value: JSON.parse(new TextDecoder().decode(result.bytes)) as unknown }
  }
}

export function remoteUrl(source: string): URL {
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || source.length > 4096) throw new TypeError('形象安装地址无效')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) !== 0 && !publicAddress(host))) throw new TypeError('形象资源必须使用公开网络地址')
  return url
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && (b === 168 || b === 0))
      && !(a === 100 && b! >= 64 && b! <= 127) && !(a === 198 && (b === 18 || b === 19))
  }
  // 只接受全局单播 IPv6，排除本地、映射 IPv4 和保留范围。
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address) && !/^2001:db8:/iu.test(address)
}

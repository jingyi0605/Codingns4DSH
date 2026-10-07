import type { AssistantAvatarCandidate } from '../../shared/assistant-avatar-installation.js'
import { AssistantAvatarRemote, remoteUrl } from './remote.js'

/** 来源适配与清单格式适配分开；GitHub 仓库定位到提交后再返回素材候选。 */
export interface AssistantAvatarSourceAdapter {
  readonly id: string
  matches(url: URL): boolean
  discover(url: URL, remote: AssistantAvatarRemote, signal?: AbortSignal): Promise<readonly AssistantAvatarCandidate[]>
}
const github: AssistantAvatarSourceAdapter = {
  id: 'github', matches: (url) => url.hostname === 'github.com',
  async discover(url, remote, signal) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const [owner, rawRepo, mode] = parts
    if (!owner || !rawRepo || !/^[\w.-]+$/u.test(owner) || !/^[\w.-]+$/u.test(rawRepo)) throw new TypeError('GitHub 仓库地址无效')
    const repo = rawRepo.replace(/\.git$/iu, '')
    const api = `https://api.github.com/repos/${owner}/${repo}`
    const repository = (await remote.json(api, signal)).value as { default_branch?: unknown }
    if (typeof repository.default_branch !== 'string') throw new TypeError('仓库没有可用的默认分支')
    let ref = repository.default_branch
    let path = ''
    if (mode !== undefined && mode !== 'tree' && mode !== 'blob') throw new TypeError('请填写 GitHub 仓库、目录或清单文件地址')
    if (mode !== undefined) {
      // 从长到短解析 ref，兼容带斜杠的分支和标签；404 才尝试下一个边界。
      const tail = parts.slice(3)
      let resolved = false
      for (let boundary = tail.length; boundary >= 1; boundary--) {
        try {
          const commit = (await remote.json(`${api}/commits/${encodeURIComponent(tail.slice(0, boundary).join('/'))}`, signal)).value as { sha?: unknown }
          if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(commit.sha)) throw new TypeError('仓库提交无效')
          ref = commit.sha; path = tail.slice(boundary).join('/'); resolved = true; break
        } catch (error) { if (!(error instanceof Error) || error.message !== 'avatar_download_http_404') throw error }
      }
      if (!resolved) throw new TypeError('无法定位仓库分支或标签')
    } else {
      const commit = (await remote.json(`${api}/commits/${encodeURIComponent(ref)}`, signal)).value as { sha?: unknown }
      if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(commit.sha)) throw new TypeError('仓库提交无效')
      ref = commit.sha
    }
    const raw = (file: string): string => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.split('/').map(encodeURIComponent).join('/')}`
    if (mode === 'blob') return [{ url: raw(path), name: path.split('/').pop() || repo }]
    const tree = (await remote.json(`${api}/git/trees/${ref}?recursive=1`, signal)).value as { truncated?: unknown; tree?: { path?: unknown; type?: unknown }[] }
    if (tree.truncated === true || !Array.isArray(tree.tree)) throw new TypeError('仓库过大，请填写具体清单文件地址')
    const files = tree.tree.filter((item) => item.type === 'blob' && typeof item.path === 'string').map((item) => item.path as string)
      .filter((file) => !path || file.startsWith(`${path}/`))
    const manifests = files.filter((file) => /(^|\/)(pet|avatar|manifest)\.json$|\.avatar\.json$|\.model3?\.json$/iu.test(file))
    const petFolders = new Set(manifests.filter((file) => /\/pet\.json$|^pet\.json$/iu.test(file)).map((file) => file.slice(0, file.lastIndexOf('/') + 1)))
    const candidates = manifests.filter((file) => !/\.model3?\.json$/iu.test(file) || !petFolders.has(file.slice(0, file.lastIndexOf('/') + 1)))
    if (candidates.length > 50) throw new TypeError('形象候选超过 50 项，请缩小到仓库子目录')
    return candidates.map((file) => ({ url: raw(file), name: file }))
  },
}
const direct: AssistantAvatarSourceAdapter = {
  id: 'url', matches: () => true,
  async discover(url) { return [{ url: url.href, name: decodeURIComponent(url.pathname.split('/').pop() || '形象包') }] },
}
export const BUILTIN_ASSISTANT_AVATAR_SOURCE_ADAPTERS: readonly AssistantAvatarSourceAdapter[] = [github, direct]
export async function discoverAssistantAvatarSource(source: string, remote: AssistantAvatarRemote, signal?: AbortSignal,
  adapters: readonly AssistantAvatarSourceAdapter[] = BUILTIN_ASSISTANT_AVATAR_SOURCE_ADAPTERS): Promise<readonly AssistantAvatarCandidate[]> {
  const url = remoteUrl(source)
  // 通用 URL 是末级回落，不能抢走后来注册的仓库来源适配器。
  const adapter = adapters.find((item) => item.id !== 'url' && item.matches(url)) ?? adapters.find((item) => item.matches(url))
  if (adapter === undefined) throw new TypeError('此形象来源尚无适配器')
  const candidates = await adapter.discover(url, remote, signal)
  if (candidates.length === 0) throw new TypeError('未发现形象清单，请填写 pet.json、avatar.json 或模型清单文件地址')
  return candidates
}

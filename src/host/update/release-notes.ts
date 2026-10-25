import { CODINGNS_GITHUB_REPOSITORY, isSemver, updateError, type PluginReleaseRecord } from '../../shared/contracts/plugin-update.js'
import { date, readUpdateJson, record, sha, type UpdateFetch } from './http.js'

export async function readPluginRelease(version: string, gitHead: string | null, request: UpdateFetch, signal: AbortSignal): Promise<PluginReleaseRecord> {
  if (!isSemver(version)) throw updateError('UPDATE_INVALID_VERSION')
  const tag = `v${version}`
  const base = `https://api.github.com/repos/${CODINGNS_GITHUB_REPOSITORY}`
  const result: PluginReleaseRecord = {
    state: 'unavailable', tag, title: null, publishedAt: null, commit: null, body: '',
    url: `https://github.com/${CODINGNS_GITHUB_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
  }
  try {
    const reference = record(await readUpdateJson(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, request, signal, 256 * 1024))
    if (!reference) return { ...result, state: 'missing', reason: 'UPDATE_TAG_MISSING' }
    if (reference.ref !== `refs/tags/${tag}`) return { ...result, reason: 'UPDATE_TAG_MISMATCH' }
    let object = record(reference.object)
    // Annotated tags can point at another tag; never follow an arbitrary API URL.
    for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
      const id = sha(object.sha)
      if (id === null) break
      object = record(record(await readUpdateJson(`${base}/git/tags/${id}`, request, signal, 256 * 1024))?.object)
    }
    const commit = object?.type === 'commit' ? sha(object.sha) : null
    if (commit === null) return { ...result, reason: 'UPDATE_TAG_INVALID' }
    if (gitHead !== null && commit !== gitHead) return { ...result, commit, reason: 'UPDATE_COMMIT_MISMATCH' }
    const release = record(await readUpdateJson(`${base}/releases/tags/${encodeURIComponent(tag)}`, request, signal, 512 * 1024))
    if (!release) return { ...result, state: 'missing', commit, reason: 'UPDATE_RELEASE_MISSING' }
    if (release.tag_name !== tag || release.draft === true) return { ...result, commit, reason: 'UPDATE_TAG_MISMATCH' }
    return {
      ...result, state: 'available', commit,
      title: typeof release.name === 'string' ? safeReleaseText(release.name, 256) : tag,
      publishedAt: date(release.published_at),
      body: typeof release.body === 'string' ? safeReleaseText(release.body, 32_768) : '',
    }
  } catch {
    signal.throwIfAborted()
    return { ...result, reason: 'UPDATE_RELEASE_UNAVAILABLE' }
  }
}

/** Render this bounded content as a React text node, never as HTML or executable Markdown. */
export function safeReleaseText(value: string, maximum: number): string {
  return value.slice(0, maximum).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

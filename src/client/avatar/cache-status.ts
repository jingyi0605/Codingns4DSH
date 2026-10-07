import { ASSISTANT_AVATAR_RESOURCE_PACKS, assistantAvatarCacheStatusPath } from '../../shared/assistant-avatar-legacy-resources.js'
import type { AssistantAvatarCacheStatus } from '../../shared/assistant-avatar-resources.js'
import { ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH } from '../../shared/assistant-avatar-installation.js'

/** 只诊断本站固定预设；查询失败不阻断模型加载，不推测浏览器是否命中缓存。 */
export async function readAssistantAvatarCacheStatus(source: string, location: string, fetchStatus: typeof fetch = (...args) => fetch(...args)): Promise<AssistantAvatarCacheStatus | undefined> {
  try {
    const origin = new URL(location)
    const model = new URL(source, origin)
    const installedId = model.origin === origin.origin && model.pathname === ASSISTANT_AVATAR_ASSET_PATH ? model.searchParams.get('pack') : null
    if (installedId !== null && /^[a-f0-9]{64}$/u.test(installedId)) {
      const response = await fetchStatus(new URL(`${ASSISTANT_AVATAR_STATUS_PATH}?pack=${installedId}`, origin).href,
        { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(250) })
      if (!response.ok) return undefined
      const value = await response.json() as AssistantAvatarCacheStatus
      if (value.version !== 1 || value.pack !== installedId || typeof value.generation !== 'string' || !value.generation || value.generation.length > 80
        || [value.cached, value.pending, value.total, value.downloads].some((number) => !Number.isSafeInteger(number) || number < 0)
        || value.total > 256 || value.cached + value.pending > value.total) return undefined
      return value
    }
    const pack = ASSISTANT_AVATAR_RESOURCE_PACKS.find((entry) => model.origin === origin.origin && model.pathname === entry.basePath + entry.manifest)
    if (pack === undefined) return undefined
    const response = await fetchStatus(new URL(assistantAvatarCacheStatusPath(pack), origin).href,
      { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(250) })
    if (!response.ok) return undefined
    const value = await response.json() as Partial<AssistantAvatarCacheStatus>
    const numbers = [value.cached, value.pending, value.total, value.downloads]
    const total = pack.files.filter((file) => file.preload !== false).length
    if (value.version !== 1 || typeof value.generation !== 'string' || value.generation.length === 0 || value.generation.length > 80
      || value.pack !== pack.basePath || value.total !== total
      || numbers.some((number) => !Number.isSafeInteger(number) || number! < 0)
      || value.cached! + value.pending! > total) return undefined
    return value as AssistantAvatarCacheStatus
  } catch { return undefined }
}

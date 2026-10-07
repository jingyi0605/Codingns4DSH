import type { AssistantAvatarModel } from './assistant-avatar.js'

/** 固定入口通过内容版本和文件键读取已安装素材，不接受远程代理目标。 */
export const ASSISTANT_AVATAR_ASSET_PATH = '/api/codingns/assistant-avatar-assets'
export const ASSISTANT_AVATAR_STATUS_PATH = '/api/codingns/assistant-avatar-cache-status'
export interface AssistantAvatarCandidate { readonly url: string; readonly name: string }
export interface AssistantAvatarInstallation {
  readonly id: string
  readonly model: AssistantAvatarModel
  readonly created: boolean
  readonly files: number
  readonly bytes: number
}
export function assistantAvatarInstalledSource(id: string, file: string): string {
  return `${ASSISTANT_AVATAR_ASSET_PATH}?pack=${id}&file=${encodeURIComponent(file)}`
}

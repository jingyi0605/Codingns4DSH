import type { AssistantAvatarModel } from './assistant-avatar.js'
import { WHALE_LIVE2D_RESOURCE_PACK } from './assistant-avatar-legacy-resources.js'

export interface AssistantAvatarPreset {
  readonly labelKey: string
  readonly model: AssistantAvatarModel
}

const spriteRoot = 'https://raw.githubusercontent.com/YunYueSama/codex-deepseek-pet/7661c8b304c5400701f91da01b1a643a207331de/codex-deepseek-pet/'
const live2dRoot = WHALE_LIVE2D_RESOURCE_PACK.upstreamRoot

/**
 * 目录保存经 Codex/DSH 适配器转换并核验的统一模型数据，不包含美术文件。
 * 固定提交避免上游 main 更新悄悄改变素材；读取目录不请求网络，选中后才由渲染器加载。
 * 预设使用独立 ID，保留此前按上游 ID 导入的用户形象与自定义清单容量。
 */
// 仅用于迁移旧版已经选中的记录；新安装不提供第三方内置目录。
export const LEGACY_ASSISTANT_AVATAR_PRESETS: readonly AssistantAvatarPreset[] = Object.freeze([
  Object.freeze({ labelKey: 'avatar.preset.whaleSprite', model: Object.freeze({
    id: 'codingns-preset-whale-sprite', name: '大肥鱼 · Q版全身',
    renderer: 'spritesheet', source: `${spriteRoot}spritesheet.webp`, spriteVersion: 2,
    package: Object.freeze({ adapterId: 'codex-pet', manifestUrl: `${spriteRoot}pet.json`, author: 'YunYueSama',
      license: '大肥鱼项目署名许可 1.0：仅授权作者有权授权的新增贡献；第三方角色与参考作品权利另行确认，非 DeepSeek 官方授权。',
      homepage: 'https://github.com/YunYueSama/codex-deepseek-pet/blob/7661c8b304c5400701f91da01b1a643a207331de/ASSET_LICENSE.md' }),
  }) }),
  Object.freeze({ labelKey: 'avatar.preset.whaleLive2d', model: Object.freeze({
    id: 'codingns-preset-whale-live2d', name: '大肥鱼 · Live2D 桌前',
    renderer: 'live2d', source: `${WHALE_LIVE2D_RESOURCE_PACK.basePath}${WHALE_LIVE2D_RESOURCE_PACK.manifest}`, spriteVersion: 2,
    motionGroups: WHALE_LIVE2D_RESOURCE_PACK.motionGroups,
    live2d: Object.freeze({ scale: 1, position: Object.freeze([0, 0] as const) }),
    package: Object.freeze({ adapterId: 'dsh-live2d-pet', manifestUrl: `${live2dRoot}pet.json`,
      author: '模型：上善无形 / ZipZipPipe / 氵六青 · 插件：A8Chann',
      license: 'CC BY-NC-SA 4.0：署名、非商业、相同方式共享；商业使用须分别取得各权利人授权。清单已精简，模型与贴图未修改。',
      homepage: 'https://github.com/A8Chann/dsh-pet-live2d/blob/185c02bfbb3b886e1a236b5c2ec035cc085b9ca2/NOTICE.md' }),
  }) }),
])

export function getAssistantAvatarPreset(id: string): AssistantAvatarPreset | undefined {
  return LEGACY_ASSISTANT_AVATAR_PRESETS.find((preset) => preset.model.id === id)
}

/** 保留旧扩展的导出名称；第三方角色现在必须手工安装。 */
export const ASSISTANT_AVATAR_PRESETS: readonly AssistantAvatarPreset[] = Object.freeze([])

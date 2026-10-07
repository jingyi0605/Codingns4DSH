import type { CodingNsHostServices } from '../features/types.js'
import type { AssistantAvatarAdapter } from '../../shared/assistant-avatar-adapters.js'
import type { AssistantAvatarSourceAdapter } from './sources.js'
import type { AssistantAvatarMaterialAdapter } from './materials.js'
import { AssistantAvatarPackages } from './packages.js'

const repositories = new WeakMap<CodingNsHostServices, AssistantAvatarPackages>()
/** Host 启停与扩展消费同一仓库；运行期注册不改源码目录或已安装记录。 */
export function getAssistantAvatarPackages(services: CodingNsHostServices): AssistantAvatarPackages {
  let packages = repositories.get(services)
  if (packages === undefined) { packages = new AssistantAvatarPackages(); repositories.set(services, packages) }
  return packages
}
/** 调用方把注销句柄加入 context.resources；格式注销不删除已经安装的素材。 */
export function registerAssistantAvatarFormatAdapter(services: CodingNsHostServices, adapter: AssistantAvatarAdapter): () => void {
  return getAssistantAvatarPackages(services).formats.register(adapter)
}
export function registerAssistantAvatarSourceAdapter(services: CodingNsHostServices, adapter: AssistantAvatarSourceAdapter): () => void {
  return getAssistantAvatarPackages(services).sources.register(adapter)
}
export function registerAssistantAvatarMaterialAdapter(services: CodingNsHostServices, adapter: AssistantAvatarMaterialAdapter): () => void {
  return getAssistantAvatarPackages(services).materials.register(adapter)
}

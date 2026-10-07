import { createElement } from 'react'
import type { ReactElement } from 'react'
import { BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../../shared/assistant-avatar.js'
import { ImageAssistantAvatar } from './image.js'
import type { AssistantAvatarRendererProps } from './registry.js'

/** 基础形象使用生图工具生成的透明 PNG，不手绘角色，也不加载第三方引擎。 */
export function BuiltinAssistantAvatar(props: AssistantAvatarRendererProps): ReactElement {
  const source = BUILTIN_ASSISTANT_AVATAR_SOURCES[props.model.id] ?? BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]!
  return createElement(ImageAssistantAvatar, { ...props, model: { ...props.model, source } })
}

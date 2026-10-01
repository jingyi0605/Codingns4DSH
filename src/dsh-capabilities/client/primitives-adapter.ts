import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

type IconComponent = ComponentType<{ readonly size?: number; readonly className?: string }>
type PrimitiveExports = typeof primitives & {
  readonly IconPlusOutlineRegular?: IconComponent
  readonly IconPlusOutlineMedium?: IconComponent
  readonly IconChevronDownOutlineRegular?: IconComponent
  readonly IconChevronDownOutlineMedium?: IconComponent
  readonly IconPlusOutline16?: IconComponent
  readonly IconChevronDownOutline14?: IconComponent
  readonly IconDataOutlineRegular?: IconComponent
  readonly IconDataOutlineMedium?: IconComponent
  readonly IconDataOutline16?: IconComponent
  readonly IconShareOutlineRegular?: IconComponent
  readonly IconShareOutlineMedium?: IconComponent
  readonly IconSendOutlineRegular?: IconComponent
  readonly IconSendOutlineMedium?: IconComponent
}

const unavailableIcon: IconComponent = () => null

/**
 * 图标导出兼容层。0.1.7 可能改名为 Regular/Medium，运行时优先使用新导出，
 * 旧导出仍作为回退；业务组件不再直接判断 DSH 版本。
 */
export function resolvePlusIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconPlusOutlineRegular ?? value.IconPlusOutlineMedium ?? value.IconPlusOutline16 ?? unavailableIcon
}

export function resolveChevronDownIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconChevronDownOutlineRegular ?? value.IconChevronDownOutlineMedium ?? value.IconChevronDownOutline14 ?? unavailableIcon
}

/**
 * 模型图标：DSH 原生模型选择器在紧凑状态显示的 data 图标（0.1.7 起为 Regular/Medium，
 * 0.1.6 为 16 后缀），插件模型选择器收起时与之保持一致。
 */
export function resolveDataIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconDataOutlineRegular ?? value.IconDataOutlineMedium ?? value.IconDataOutline16 ?? unavailableIcon
}

/**
 * `/委派` 菜单行图标：优先使用共享（send/share）字形，缺失时回退到插件通用的
 * data 图标，保证旧版 DSH 仍能渲染出一行可识别的委派入口。
 */
export function resolveDelegateIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconShareOutlineRegular
    ?? value.IconShareOutlineMedium
    ?? value.IconSendOutlineRegular
    ?? value.IconSendOutlineMedium
    ?? resolveDataIcon()
}

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

type IconComponent = typeof primitives.IconPlusOutline16

/**
 * 图标导出兼容层。0.1.7 可能改名为 Regular/Medium，运行时优先使用新导出，
 * 旧导出仍作为回退；业务组件不再直接判断 DSH 版本。
 */
export function resolvePlusIcon(): IconComponent {
  const value = primitives as typeof primitives & { IconPlusOutlineRegular?: IconComponent; IconPlusOutlineMedium?: IconComponent }
  return value.IconPlusOutlineRegular ?? value.IconPlusOutlineMedium ?? primitives.IconPlusOutline16
}

export function resolveChevronDownIcon(): IconComponent {
  const value = primitives as typeof primitives & { IconChevronDownOutlineRegular?: IconComponent; IconChevronDownOutlineMedium?: IconComponent }
  return value.IconChevronDownOutlineRegular ?? value.IconChevronDownOutlineMedium ?? primitives.IconChevronDownOutline14
}

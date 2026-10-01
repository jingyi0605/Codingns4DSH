/**
 * panels 域词典片段。
 *
 * 只放该域新增的键；合并与命名空间注册由 ../locale.ts 统一完成。
 * 规范见 docs/开发规范/20260930-前端文案国际化规范.md。
 */
export const en: Record<string, string> = {
  'common.listSeparator': ', ',
  'settings.unknownVersion': 'Unknown version',
  'settings.maintenanceDisabled': 'This module is disabled by maintenance policy; the setting will not start it.',
  'cli.thinkingLevelTitle': 'Thinking level ({model})',
  'cli.adapterEnabled': '{name} enabled',
  'cli.adapterDisabled': '{name} disabled',
  'lan.fieldListenPort': 'listen port',
  'lan.fieldDshPort': 'DSH local port',
  'lan.fieldMustBeNumber': '{field} must be a number',
  'lan.fieldMustBeInteger': '{field} must be an integer from {minimum} to 65535',
  'workspace.sessionSettingsSaved': 'Workspace session settings saved',
}

export const zh: Record<string, string> = {
  'common.listSeparator': '、',
  'settings.unknownVersion': '未知版本',
  'settings.maintenanceDisabled': '该模块当前由维护策略停用，设置不会启动它。',
  'cli.thinkingLevelTitle': '思考等级（{model}）',
  'cli.adapterEnabled': '已启用 {name}',
  'cli.adapterDisabled': '已停用 {name}',
  'lan.fieldListenPort': '监听端口',
  'lan.fieldDshPort': 'DSH 本地端口',
  'lan.fieldMustBeNumber': '{field} 必须是数字',
  'lan.fieldMustBeInteger': '{field} 必须是 {minimum} 到 65535 的整数',
  'workspace.sessionSettingsSaved': '工作区会话设置已保存',
}

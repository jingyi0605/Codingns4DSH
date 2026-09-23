# Spec 004：工作区会话 Logo 增强

状态：IN_REVIEW

## 目标

在不修改 DeepSeek Harness（DSH）0.1.6-alpha.2 安装内容的前提下，让 CodingNS 插件在原生工作区会话行最左侧显示对应 Agent Logo。

## 文档

- [需求文档](requirements.md)
- [设计文档](design.md)
- [任务清单](tasks.md)
- [兼容性与验收记录](docs/20260923-兼容性与验收记录.md)

## 明确边界

- 本 Spec 只做浏览器端 Logo 注入。
- 不提供会话删除、归档替代、菜单扩展或持久化清理。
- 不修改 DSH 源码或已安装的 `node_modules`。
- 只支持仓库锁定的 DSH `0.1.6-alpha.2` DOM 与 React 运行时结构；无法识别时不修改原生页面。

# 需求文档 - 工作区会话 Logo 增强

状态：IN_REVIEW

## 简介

DSH 原生工作区列表不会显示会话由哪个 Agent 处理。CodingNS 已在 Host 保存 `dshSessionId -> adapterId` 绑定，本功能只把这份已有关系显示到原生会话行，不复制 WorkspaceBrowser，也不改变会话标题。

## 术语表

- **会话行**：DSH WorkspaceBrowser 在分组、平铺或搜索结果中渲染的一条 Session。
- **绑定索引**：`CodingNsCliSessionStore` 保存的 `dshSessionId -> adapterId` 关系。
- **兼容注入器**：针对 DSH 0.1.6-alpha.2 DOM 与 React Fiber 结构定位会话行并插入 Logo 的浏览器代码。

## 范围说明

### In Scope

- 稳定模块名 `workspaceSessionEnhancement`，默认关闭并依赖 `cliAdapters`。
- 设置 `workspaceSessionEnhancement.showAdapterLogo`，默认开启，支持实时切换。
- 一次读取脱敏会话映射，按 sessionId 在内存中 O(1) 查询。
- 在分组、平铺及搜索结果行状态点之前插入 16x16 Logo。
- 模块停用或子开关关闭时立即移除观察器和全部注入节点。

### Out of Scope

- 会话删除、删除确认框、删除 RPC 和持久化清理。
- 会话行操作菜单扩展。
- 修改 DSH 源码、安装包或运行时模块导出。
- 修改会话标题以携带适配器信息。

## 需求

### 需求 1：正确显示 Agent Logo

**用户故事：** 作为使用多个 Agent 的用户，我希望从原生会话列表直接识别每条会话的 Agent，以便快速选择正确会话。

#### 验收标准

1. WHEN 会话绑定到已知适配器 THEN 系统 SHALL 在状态点之前显示对应的 16x16 Logo。
2. WHEN 会话没有外部适配器绑定 THEN 系统 SHALL 按 DSH 默认会话显示 DeepSeek Harness Logo。
3. WHEN 会话保存了未知适配器 THEN 系统 SHALL 显示稳定的通用占位，不错误显示成 Codex。
4. WHEN 行标题很长或侧栏很窄 THEN 系统 SHALL 保持原生行高和标题省略行为。
5. WHEN 展示 Logo THEN `img` SHALL 使用空 `alt` 和 `aria-hidden`，外层 `title` 显示适配器名称。

### 需求 2：开关实时生效

**用户故事：** 作为用户，我希望独立控制该模块及 Logo 显示，以便随时恢复完全原生的会话列表。

#### 验收标准

1. WHEN 模块总开关关闭 THEN 系统 SHALL 保留子开关值、灰显设置并移除全部注入内容。
2. WHEN `showAdapterLogo` 改变 THEN 系统 SHALL 不重启 DSH 即刻增加或移除 Logo。
3. WHEN 模块反复启停 THEN 系统 SHALL 不残留重复观察器、样式或 Logo 节点。

### 需求 3：兼容失败不破坏原生界面

**用户故事：** 作为维护者，我希望兼容代码失效时安静退出，以免 DSH 页面结构变化导致错标或交互损坏。

#### 验收标准

1. WHEN 无法从行节点解析唯一 sessionId THEN 系统 SHALL 保持该行不变。
2. WHEN Host 映射读取失败 THEN 系统 SHALL 使用无绑定占位且不记录敏感字段。
3. WHEN 模块卸载 THEN 系统 SHALL 断开 MutationObserver、取消迟到结果并清除注入节点。

## 非功能需求

### 性能

- 映射按列表整批读取，不为每个会话行单独发送 RPC。
- DOM 变化在同一微任务内合并扫描，已处理节点不重复创建元素。

### 安全

- 浏览器只接收 `sessionId` 和 `adapterId`。
- `providerSessionId`、`rawStoreRef`、CLI 路径、凭据和错误上下文不得进入缓存、DOM 或日志。

### 可维护性

- 适配器 Logo 与显示名称只有一份映射。
- 兼容代码集中在独立文件，并明确锁定 DSH 0.1.6-alpha.2。

## 成功定义

- 九个已知适配器及未知值映射测试通过。
- 分组、平铺、搜索、重复扫描、启停和资源释放测试通过。
- 类型检查、构建、相关测试及全量 Node 测试达到可归因的通过状态。

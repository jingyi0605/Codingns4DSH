# 设计文档 - 工作区会话 Logo 增强

状态：IN_REVIEW

## 1. 目标与限制

DSH 0.1.6-alpha.2 没有会话行 leading Slot，原生行 DOM 也没有 `data-session-id`。本实现采用固定版本兼容代码：查询 `role="treeitem"`，再从节点关联的 React Fiber 只读提取 `SessionNodeItem.node.id` 或 `SearchResultItem.result.id`。解析失败就不修改该行。

删除功能已经取消。本设计不包含任何删除、归档或存储文件操作。

## 2. 数据流

1. Host 从现有 `CodingNsCliSessionStore` 生成 `{ sessionId, adapterId }[]`，不建立第二份持久化绑定。
2. Client 模块启动后整批读取映射，保存为 `Map<string, string>`。
3. 原有 Agent 选择器改变绑定时，更新同一浏览器缓存并通知注入器。
4. 注入器扫描当前会话行，从 React Fiber 解析 sessionId，再 O(1) 查询适配器。
5. MutationObserver 只负责发现新增或替换的行，同一轮变化合并为一次扫描。

## 3. 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `workspaceSessionEnhancement` | 启停注入器、监听子开关 | Host 会话生命周期 |
| `session-adapter-cache` | 保存脱敏映射、通知变化 | 持久化权威数据 |
| `workspace-session-logo-dom` | 解析行身份、插入和清理 Logo | 修改 React 状态或 DSH 模块 |
| `provider-icons` | 唯一的 Logo 与显示名称映射 | 会话绑定关系 |

## 4. 设置

```ts
interface WorkspaceSessionEnhancementSettings {
  showAdapterLogo: boolean
}
```

- 模块启用意图仍保存在 `modules.workspaceSessionEnhancement`。
- 子设置保存在 `workspaceSessionEnhancement.showAdapterLogo`，默认 `true`。
- 模块关闭时面板仍显示，但使用 `disabled` 和 `aria-disabled` 禁止操作。

## 5. DOM 兼容策略

### 5.1 身份解析

- 只读取 DOM 节点自身的 `__reactFiber$*` 属性。
- 向上遍历有限层级，接受 `memoizedProps.node.id` 或 `memoizedProps.result.id`。
- 不读取消息、路径、Provider 会话 ID 或其他私有 props。
- 没有唯一非空 id 时返回 `undefined`，不按标题猜测。

### 5.2 插入位置

- 分组和平铺行：插入为会话行第一个子节点，位于原生状态点之前。
- 搜索行：插入到标题行第一个子节点，位于搜索状态点之前。
- Logo 容器固定 `16x16` 且 `flex: 0 0 16px`，不改变原生 32px 行高。
- 图片 `object-fit: contain`，长标题继续由原生 flex 和 ellipsis 处理。

### 5.3 生命周期

- 启用：加载一次映射、安装一个 MutationObserver、扫描当前 DOM。
- 映射变化：只重扫已存在行，不新发逐行 RPC。
- 停用：断开观察器、使异步 generation 失效、移除所有带插件标记的节点。
- 重复启用：先完成上一 generation 清理，不允许重复注入。

## 6. DSH 默认值和未知适配器

- 已知适配器：使用复制到插件包并内联到 Client bundle 的真实资产。
- 没有外部适配器绑定：沿用 Registry 的默认语义，按 `dsh` 显示 DeepSeek Harness Logo。
- 未知适配器：显示中性的 `?` 占位，title 为 `未知 Agent（adapterId）`。
- 未知值不会回落到 Codex 或其他已知品牌。

## 7. 接口契约

### `cli/session/adapter-map`

- 输入：空对象。
- 输出：`Array<{ sessionId: string; adapterId: string }>`。
- 数据源：当前 `CodingNsCliSessionStore.list()`。
- 安全边界：不得包含 providerSessionId、rawStoreRef、cwd、title、模型、命令路径或错误字段。

## 8. 正确性属性

1. 同一行最多存在一个 `data-codingns-session-logo` 节点。
2. 缓存中同一 sessionId 只有一个 adapterId，后到更新覆盖旧值。
3. 任何无法解析 sessionId 的 DOM 行都保持不变。
4. dispose 完成后，观察器和插件注入节点数量都为零。

## 9. 测试策略

- 单元测试：适配器映射、缓存替换/增量更新、Fiber 身份解析、插入位置、重复扫描、清理。
- 模块测试：默认关闭、依赖、设置持久化、总开关和子开关实时启停。
- 构建测试：Logo 资产内联、Client 不包含 Node 模块、Host-only 字段不进入新接口。
- 人工验收：真实 DSH 的亮色、暗色、窄侧栏、长标题、分组、平铺和搜索结果。

## 10. 风险

- React Fiber 属性不是公开 API。本实现只支持 DSH 0.1.6-alpha.2，版本升级必须重新验收。
- 自动测试可以验证兼容算法，不能替代真实宿主视觉和交互验收。
- Host 目前没有会话绑定推送事件；同一浏览器内的选择变化实时更新，其他客户端产生的变化需等待列表重新加载或模块重启。

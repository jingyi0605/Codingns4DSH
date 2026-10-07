# 设计文档 - 终端工作区聚合与内置列表

状态：实施中。

## 1. 设计目标

1. 用工作区终端库存作为唯一事实来源，移除 Host 终端与 Sidebar 标签的一对一绑定。
2. 让 Sidebar 只承载一个聚合页入口，终端身份和生命周期全部在插件内部管理。
3. 兼容旧布局、空库存和创建竞态，避免关闭或恢复动作误伤 Host 进程。

## 2. 架构

```text
DSH session A ─┐
DSH session B ─┼─ 一个 terminal 聚合页签
DSH session C ─┘          │
                          ├─ 工作区终端库存
                          ├─ 终端列表
                          └─ 选中 terminalId 的 CodingNsTerminalView
                                      │
                                      ├─ 所有终端 view/attach 常驻内存
                                      ├─ Host 每个 terminalId 一条 resident attachment
                                      ├─ resident 保留有限原始输出供新订阅恢复
                                      └─ 只切换 active 可见层
                                      ▼
                              Host workspace terminal list/create/close
```

### 2.1 组件职责

| 组件 | 职责 |
| --- | --- |
| `CodingNsWebTerminals` | 保存按工作区划分的库存快照、选中子终端、卡片开关、revision、终端视图和 Host 操作。 |
| `createTerminalSessionRecovery` | 将工作区卡片开关投影到各会话；每个会话最多打开一个聚合页；库存为空时关闭聚合页；迁移旧多标签。 |
| `TerminalBody` | 在顶部横向标签栏渲染内部列表，在下方渲染选中终端内容，处理页内新建、选择、重命名、关闭。 |
| `TerminalTitle` | 固定显示“终端”，不再绑定某个 Host 终端标题。 |
| `TerminalCleanup` | 监听库存与卡片开关 revision、当前会话和布局索引，触发已知会话的聚合页同步。 |

## 3. 状态模型

### 3.1 工作区库存

`CodingNsWebTerminals` 增加按 `workspaceId` 保存的库存快照和可订阅 revision。每次 `recover`、创建成功、关闭成功或 Host 列表刷新后更新快照：

```ts
interface TerminalInventory {
  readonly workspaceId: string
  readonly terminals: readonly WebTerminalInfo[]
  readonly revision: number
}
```

同一工作区的所有会话读取同一库存；sessionId 仅作为 Remote 调用上下文和当前 attach 会话，不参与终端唯一性。

### 3.2 聚合页参数

聚合页不把 `terminalId` 写入 Sidebar navigation params。创建入口只传递一次性的 `autoCreate`/Shell 选择意图，恢复页只读取库存。旧标签仍可读取 `terminalId`，迁移时不使用它关闭 Host。

### 3.3 终端视图

`viewForTerminal(sessionId, terminalId, shellPath?)` 使用工作区作用域与 `terminalId` 缓存模型。同工作区所有会话共用同一个模型和 follow；工作区解析前创建的模型在解析后迁入工作区缓存，不能重复创建。会话仅提供当前可见卡片的 Remote 调用上下文。

Host `CodingNsTerminalService` 为每个 running 终端建立一条不绑定浏览器 generation 的 resident attachment（常驻连接）。`follow` 只注册内存 follower（输出订阅），并复用 resident 的输入、尺寸和输出通道。新页面首次订阅通过历史捕获或有限输出缓存恢复快照，随后接收状态与增量输出；同页面内切换会话不再创建新订阅。

聚合页同时渲染库存中的所有 `CodingNsXtermView`。`TerminalSurfaceCache` 为每个模型保留唯一 xterm 屏幕，跨会话仅移动屏幕 DOM；隐藏子标签、卸载或关闭 Sidebar 卡片不销毁屏幕。屏幕持有 `view.mount()` 和状态订阅，隐藏期间继续写入与确认每一帧，保留缓冲区、光标、备用屏幕和滚动位置。只有模型 dispose 才销毁屏幕与连接。

仅当前可见且选中的卡片同步外观、尺寸与焦点；隐藏卡片不能按 Host 尺寸重设共享屏幕。首次快照、实际尺寸变化、真实断线和显式刷新保留原有恢复行为。Host 对相同尺寸直接返回，不触发 backend resize 或历史重放。

### 3.4 工作区选择与卡片状态

同工作区各会话共用 `{ selectedId?, cardOpen? }` 状态，保存在浏览器内存和 `dsh.codingns.terminal.workspace-state.v1.` 存储命名空间。作用域键为 JSON 编码的 `['workspace', workspaceId]`；环境缺少工作区 ID 时才退回 `['session', sessionId]`。旧会话级选择记录仅在尚无工作区记录时迁移，不能覆盖已有共享选择。

会话只负责定位工作区和提供 Host 调用上下文，组件直接订阅共享选择。卡片开关变更独立通知恢复组件，子标签选择不触发卡片库存重新查询。工作区尚未解析时发生的显式开关暂存为待处理意图，解析后覆盖旧开关；创建开始写入打开意图，创建结束不再改写卡片开关。

用户关闭通过原生 `registerCloseHandler` 写入共享关闭状态，并同步移除同工作区其他会话的卡片。恢复、空库存清理和旧多标签迁移经过关闭钩子时，用投影标记阻止它们反向改写工作区开关。

## 4. 关键流程

### 4.1 打开和恢复

1. `TerminalCleanup` 为当前 mounted session 调用 recovery。
2. recovery 请求 Host 工作区库存。
3. 工作区卡片开关未关闭、库存非空且当前会话没有聚合页时，调用 `openTabIn(sessionId, 'terminal')`；布局尚未装配时允许后续恢复重试，不把调用已发出当作卡片已打开。
4. 当前会话存在多个旧 terminal 标签时，保留一个并用 Sidebar 关闭路径移除多余布局记录，关闭回调不得结束 Host 进程。
5. 库存为空时，关闭当前会话所有聚合页；已知其他会话由库存 revision 再次收敛。

### 4.2 页内新建

1. 用户在聚合页点击新建并选择 Shell。
2. `CodingNsWebTerminals.createTerminal` 生成唯一 `terminalId`，调用 Host create。
3. Host 返回成功后更新工作区库存和 revision。
4. 聚合页选择新终端并挂载其视图。

### 4.3 页内关闭

1. 用户在列表项点击关闭。
2. 仅按该项 `terminalId` 调用 Host close。
3. close 成功后刷新库存；库存为空时所有会话聚合页自动关闭。
4. 聚合页标签自身的关闭动作更新工作区共享开关，并移除同工作区各会话的 Sidebar 布局，不触发 Host close；再次打开保留共享子终端选择。

## 5. 恢复和兼容

- 新版本不再注册 `multiple:true`，避免 DSH 按打开次数生成多个内容地址。
- terminal guide 只作为创建入口存在，不代表已有终端页签；终端类型本身仍声明 `multiple: false`。
- DSH 当前同时注册 Git 和 Debug guide 时不会把终端作为唯一默认页；入口点击后才打开聚合页，并通过 `autoCreate` 传递一次性创建意图。
- 旧版每终端标签迁移时只做 Sidebar 记录收敛，不根据旧标签触发 Host close。
- 无法读取 workspaceId 时退回当前 session 的库存和会话级兼容行为，不写入错误的工作区绑定。

## 6. 测试策略

### 6.1 单元测试

- 库存按 workspaceId 去重和 revision 通知。
- 创建第二个终端得到不同 terminalId。
- 关闭一个终端只关闭对应 Host 记录。
- 空库存关闭聚合页；创建竞态保留新终端。
- 旧多个 Sidebar 标签只收敛为一个且不调用 Host close。

### 6.2 UI/恢复测试

- tab definition 为单实例且不声明 per-terminal guide。
- recovery 每个 session 最多打开一个 terminal tab。
- 聚合页内部选择、新建、关闭和空状态行为有源代码契约测试。

### 6.3 集成验证

```text
pnpm run typecheck
pnpm run build
pnpm test
```

## 7. 风险

- DSH 旧布局可能在升级首次恢复时包含多个 terminal 标签，必须先执行无 Host close 的迁移。
- 没有终端时不能删除创建入口，否则用户无法建立第一个终端；隐藏目标是已打开的聚合页签。
- Host 没有库存事件推送，库存同步以显式 refresh + revision 为准；连接断开时保留当前视图并允许重试。终端切换不再主动断开连接，Host 只在显式关闭、运行时退出、插件卸载时清理 resident attachment；连接层异常保留 follower，后台重建 resident 并重绑控制权。

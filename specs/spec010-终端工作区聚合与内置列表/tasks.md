# 任务清单 - 终端工作区聚合与内置列表

状态：已完成。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `DONE`：已完成并回写验证证据

## 阶段 0：Spec 与边界

- [x] 0.1 建立需求、设计和任务清单
  - 状态：DONE
  - 这一步到底做什么：记录聚合页、库存同步、旧标签迁移和无终端隐藏语义。
  - 做完你能看到什么：实现边界、数据结构和验收方式明确。
  - 先依赖什么：无。
  - 开始前先看：`AGENTS.md`、`specs/000-Spec规范/Spec模板/`、现有终端源码。
  - 主要改哪里：本 Spec 四份文档、`AGENTS.md` 索引。
  - 这一步先不做什么：不改终端实现。
  - 怎么算完成：需求、设计、任务可以互相追踪。
  - 怎么验证：文档走查、`git diff --check`。

## 阶段 1：库存和视图模型

- [x] 1.1 增加工作区终端库存与 revision 订阅
  - 状态：DONE
  - 这一步到底做什么：让所有聚合页共享同一工作区终端列表，并能在创建/关闭后刷新。
  - 做完你能看到什么：任一会话刷新后，其他会话能收到库存变化。
  - 先依赖什么：0.1。
  - 开始前先看：`requirements.md` 需求 2、3；`design.md` §3.1。
  - 主要改哪里：`src/client/terminal/model.ts`、`tests/terminal-client-model.spec.ts`。
  - 这一步先不做什么：不改 Sidebar 注册和页面布局。
  - 怎么算完成：库存按 workspaceId 去重，revision 通知稳定，旧 session 兼容。
  - 怎么验证：终端模型定向测试、`pnpm run typecheck`；库存内容未变化时 revision 不递增。

- [x] 1.2 增加按 terminalId 缓存的内部视图与页内 Host 操作
  - 状态：DONE
  - 这一步到底做什么：提供 `viewForTerminal`、createTerminal、closeTerminal 等明确接口。
  - 做完你能看到什么：UI 可以按列表项挂载终端，不依赖 Sidebar tabId 或 navigation params。
  - 先依赖什么：1.1。
  - 开始前先看：`requirements.md` 需求 2；`design.md` §3.2、§3.3、§4.2、§4.3。
  - 主要改哪里：`src/client/terminal/model.ts`、`tests/terminal-client-model.spec.ts`。
  - 这一步先不做什么：不移除旧恢复逻辑。
  - 怎么算完成：新建得到唯一 ID，关闭只结束目标 ID，视图卸载只 detach。
  - 怎么验证：模型测试、类型检查；聚合视图不写入 Sidebar 绑定，关闭操作按 terminalId 收敛。

### 阶段检查 1.3

- [x] 1.3 库存和视图模型检查
  - 状态：DONE
  - 这一步到底做什么：确认 Host 终端身份已完全从 Sidebar tabId 解耦。
  - 做完你能看到什么：进入 UI 改造时不需要再补 session/tab 绑定分支。
  - 先依赖什么：1.1、1.2。
  - 开始前先看：`requirements.md`、`design.md` §3、§4。
  - 主要改哪里：阶段 1 全部文件。
  - 这一步先不做什么：不处理旧 Sidebar 布局。
  - 怎么算完成：模型测试通过，数据流只有 workspace inventory → terminal view。
  - 怎么验证：终端模型测试通过，数据流已收敛为 workspace inventory → terminal view。

## 阶段 2：聚合页与恢复迁移

- [x] 2.1 改为单一终端 Sidebar 页签和创建入口
  - 状态：DONE
  - 这一步到底做什么：移除 per-terminal `multiple` 和静态唯一 guide，注册一个聚合页并保留创建入口。
  - 做完你能看到什么：新建多个终端时顶部只有一个“终端”标签。
  - 先依赖什么：1.3。
  - 开始前先看：`requirements.md` 需求 1、4；`design.md` §2、§5。
  - 主要改哪里：`src/client/terminal/ui.ts`、`src/client/terminal/styles.ts`、UI 测试。
  - 这一步先不做什么：不改变 Host 终端协议。
  - 怎么算完成：终端类型声明 `multiple: false`，Guide 入口只传递一次性创建意图。
  - 怎么验证：UI 源码契约测试、构建通过。

- [x] 2.2 实现聚合页内部列表、选择和操作
  - 状态：DONE
  - 这一步到底做什么：在 TerminalBody 内渲染列表和选中终端内容，实现页内新建、重命名、关闭。
  - 做完你能看到什么：多个终端共享一个页签，切换不会创建新 Sidebar 标签。
  - 先依赖什么：2.1、1.2。
  - 开始前先看：`requirements.md` 需求 2、4；`design.md` §4。
  - 主要改哪里：`src/client/terminal/ui.ts`、`src/client/terminal/xterm-view.ts`、`src/client/terminal/styles.ts`、对应测试。
  - 这一步先不做什么：不处理旧版多标签迁移。
  - 怎么算完成：列表操作只按 terminalId 调模型，空列表不留下页签。
  - 怎么验证：UI/模型定向测试、构建通过；第二个终端使用独立 terminalId。

- [x] 2.3 将 recovery 改为一会话一聚合页并迁移旧标签
  - 状态：DONE
  - 这一步到底做什么：库存非空时最多打开一个 terminal tab，清理多余旧标签时不触发 Host close。
  - 做完你能看到什么：升级后旧的 zsh 标签收敛为一个终端页，运行中的 Host 进程仍在。
  - 先依赖什么：2.1、2.2。
  - 开始前先看：`requirements.md` 需求 5；`design.md` §4.1、§5。
  - 主要改哪里：`src/client/terminal/recovery.ts`、`src/client/terminal/ui.ts`、恢复测试。
  - 这一步先不做什么：不改变 Host list/create/close 协议。
  - 怎么算完成：空库存关闭聚合页，多旧标签只保留一个，迁移不关闭 Host。
  - 怎么验证：恢复测试、全量终端测试；多旧标签迁移只调用 Sidebar closeIn，不调用 Host close。

### 阶段检查 2.4

- [x] 2.4 聚合页主链路检查
  - 状态：DONE
  - 这一步到底做什么：验证“创建 → 列表 → 切换 → 关闭 → 空页隐藏”完整链路。
  - 做完你能看到什么：两个会话不会出现终端残留，第二个终端不会和第一个重复。
  - 先依赖什么：2.1、2.2、2.3。
  - 开始前先看：本 Spec 全部文档。
  - 主要改哪里：终端模块和测试。
  - 这一步先不做什么：不新增终端协议能力。
  - 怎么算完成：关键场景全部有自动化或人工证据。
  - 怎么验证：`pnpm run typecheck`、`pnpm run build`、终端定向测试通过；stage0 需在实际 Profile 中回放创建、切换和关闭链路。

## 阶段 3：收尾和验收

- [x] 3.1 补齐文档和开发记录
  - 状态：DONE
  - 这一步到底做什么：回写任务状态、开发记录和最终验证证据。
  - 做完你能看到什么：后续维护者能知道聚合页的生命周期边界。
  - 先依赖什么：2.4。
  - 开始前先看：`AGENTS.md` 文档规则、本 Spec 全部文档。
  - 主要改哪里：`docs/开发记录/20261002-终端工作区聚合与内置列表实现记录.md`、`AGENTS.md`。
  - 这一步先不做什么：不修改 DSH 外部 Profile。
  - 怎么算完成：文档索引、任务状态和验证命令一致。
  - 怎么验证：`git diff --check`、文档链接检查。

- [x] 3.2 最终检查
  - 状态：DONE
  - 这一步到底做什么：确认 Spec 验收标准全部满足。
  - 做完你能看到什么：可以在 stage0 中连续新建、切换和关闭终端而不再出现重复或残留。
  - 先依赖什么：3.1。
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`。
  - 主要改哪里：当前 Spec 全部文件和终端模块。
  - 这一步先不做什么：不追加新的终端功能。
  - 怎么算完成：关键需求、自动化检查全部通过。
  - 怎么验证：`pnpm run typecheck`、`pnpm run build`、终端定向测试通过；`pnpm test` 全量 1091 项通过（含 PeerHost `session/follow` 合并刷新用例改为模拟定时器后的稳定结果）。

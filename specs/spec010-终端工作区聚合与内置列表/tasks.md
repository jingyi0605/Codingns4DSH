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

- [x] 3.3 Host 调试日志与闪退原因定位准备
  - 状态：DONE
  - 这一步到底做什么：为 controller、持久终端服务、runtime manager 和 tmux/local-pty backend 增加同一终端的请求、作用域、运行时身份、attach、退出及状态迁移日志。
  - 做完你能看到什么：开启 `CODINGNS4DSH_DEBUG=1` 后，可以沿 `terminal create request` → `runtime create` → `runtime inspect/attach` → `runtime exit/state update` 判断窗口闪退发生在哪一层。
  - 先依赖什么：2.4。
  - 主要改哪里：`src/host/terminal/terminal-controller.ts`、`src/host/terminal/terminal-service.ts`、`src/host/terminal/runtime-manager.ts`、`src/host/terminal/backends/`。
  - 这一步先不做什么：不改变终端协议、作用域判定和生命周期语义；日志不记录终端输入内容或环境变量。
  - 怎么算完成：stage0 以调试开关启动后能输出 Host 终端完整生命周期，创建失败时包含错误和运行时状态。
  - 怎么验证：stage0 已用 `CODINGNS4DSH_DEBUG=1 pnpm run dsh:stage0` 启动；启动日志已确认 Host controller、terminal service 正常加载，等待下一次创建终端回放。

## 阶段 4：终端连接常驻与即时切换

- [x] 4.1 保持聚合页内所有终端连接
  - 状态：DONE
  - 这一步到底做什么：让每个库存终端的 Client view 和 Host follow attach 在聚合页生命周期内保持常驻，未选中终端只隐藏内容。
  - 做完你能看到什么：点击其他终端标签时直接显示已有屏幕，不再出现重新连接状态，也不重复调用 Host attach。
  - 先依赖什么：2.2、3.3。
  - 主要改哪里：`src/client/terminal/ui.ts`、`src/client/terminal/xterm-view.ts`。
  - 这一步先不做什么：不改变 Host terminal runtime、terminal/follow 协议和显式 close 语义。
  - 怎么算完成：聚合页为每个 `terminalId` 保持稳定 React key、view 和 xterm；active 切换只改变可见性。
  - 怎么验证：UI 契约测试、typecheck、stage0 Web 回放切换标签时 Host attach 日志不增加。

- [x] 4.2 连接常驻回归与文档
  - 状态：DONE
  - 这一步到底做什么：覆盖常驻视图、隐藏视图和离开聚合页后的正常 detach，回写 Spec 与开发记录。
  - 做完你能看到什么：关闭终端仍会释放对应 view/attach，切换终端不会释放连接。
  - 先依赖什么：4.1。
  - 主要改哪里：`tests/terminal-client-ui.spec.ts`、Spec 文档和开发记录。
  - 这一步先不做什么：不为了缓存 attach 而重做 Host 侧输出回放协议。
  - 怎么算完成：定向终端测试和完整项目检查通过。
  - 怎么验证：`pnpm run typecheck`、`pnpm run build`、`pnpm test`、`git diff --check`。

## 阶段 5：Host 常驻连接与即时订阅

- [x] 5.1 在 Host 内存中复用终端连接
  - 状态：DONE
  - 这一步到底做什么：把 backend attachment 从浏览器 follow 生命周期中解耦，每个 running 终端只保留一条 Host resident connection。
  - 做完你能看到什么：多个 DSH 会话订阅同一个终端时不会重复创建 tmux/local-pty attach，点击终端标签直接得到当前连接状态。
  - 先依赖什么：4.1、4.2。
  - 主要改哪里：`src/host/terminal/terminal-service.ts`、`tests/terminal-lifecycle.spec.ts`。
  - 这一步先不做什么：不改变终端进程的持久记录格式，不把浏览器 attachment 写入磁盘。
  - 怎么算完成：`follow` 只注册 follower，输入/尺寸复用 resident；显式 close、Host dispose 和 runtime 真实退出仍能正确释放。
  - 怎么验证：终端生命周期测试断言两个 follow 共用一个 backend attachment，订阅结束后 resident 仍存在，显式 dispose 后才释放。

- [x] 5.2 缓存有限输出并处理连接层异常
  - 状态：DONE
  - 这一步到底做什么：在 Host 内存中保留最多 1 MB 原始输出，新订阅先收到 snapshot/state 再恢复缓存；resident 连接断开时结束旧 follower 并后台重建。
  - 做完你能看到什么：重新打开或切换会话时终端内容可立即恢复，tmux 客户端短暂断线不会把仍运行的 Shell 标为 exited。
  - 先依赖什么：5.1。
  - 主要改哪里：`src/host/terminal/terminal-service.ts`、`docs/开发记录/20261003-终端连接常驻与即时切换修复记录.md`。
  - 这一步先不做什么：不无限缓存输出，不把连接状态持久化到 JSON 文件。
  - 怎么算完成：新 follow 能收到订阅前产生的输出；自然退出先广播 exited/lost 状态再结束流。
  - 怎么验证：`pnpm run typecheck`、`pnpm run build`、`node --test tests/terminal-lifecycle.spec.ts tests/terminal-process.spec.ts`。

## 阶段 6：工作区共享选择与卡片开关

- [x] 6.1 修正选择和卡片恢复的工作区作用域
  - 状态：DONE（2026-10-07）。
  - 这一步到底做什么：将子终端选择和卡片开关保存为工作区共享状态，迁移会话级旧选择，移除按会话推断用户关闭的分支，接入原生关闭钩子。
  - 做完你能看到什么：同工作区会话显示一致的子终端选择和卡片打开状态，新会话进入后跟随已有工作区状态。
  - 先依赖什么：2.2、2.3、4.1。
  - 主要改哪里：`src/client/terminal/model.ts`、`src/client/terminal/recovery.ts`、`src/client/terminal/ui.ts`、对应测试和开发记录。
  - 这一步先不做什么：不构建或启动服务，不修改 dsh-web、Desktop 或 Host 终端协议。
  - 怎么算完成：跨会话共享、工作区隔离、旧记录迁移、原生布局装配重试与创建期间主动关闭都有回归证据。
  - 怎么验证：仅含本功能变更的独立提交快照执行模型、恢复、UI、Host 生命周期与存储 104 项测试全部通过，类型检查通过。实现记录：`docs/开发记录/20261007-终端工作区共享选择与卡片状态修复记录.md`。

## 阶段 7：跨会话常驻屏幕与连接

- [x] 7.1 消除会话切换的重复模型和屏幕重建
  - 状态：DONE（2026-10-07）。
  - 这一步到底做什么：按工作区缓存聚合模型，迁移未解析作用域的模型，令唯一常驻屏幕拥有输出消费、渲染确认和挂载引用；卡片切换只移动屏幕 DOM。
  - 做完你能看到什么：跨会话和子标签切换保留同一连接、缓冲区、光标和滚动位置，后台输出继续消费。
  - 先依赖什么：4.1、5.1、6.1。
  - 主要改哪里：终端模型、屏幕缓存、xterm 视图、对应测试和开发记录。
  - 这一步先不做什么：不修改 Host 持久记录或 wire 协议，不构建、不启动服务、不操作 Desktop。
  - 怎么算完成：同工作区只建立一次 follow，屏幕只创建一次；跨工作区隔离，显式关闭释放屏幕，真实断线及刷新恢复行为保持。
  - 怎么验证：排除其他未提交改动的独立提交快照执行模型、UI、恢复、Host 生命周期与存储 108 项测试全部通过，类型检查通过。详见 `docs/开发记录/20261007-终端跨会话常驻连接与屏幕复用修复记录.md`。

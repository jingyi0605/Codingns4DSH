# Spec003 任务清单

状态：范围收敛后重新排期。每项任务必须在验证通过后才标记 `DONE`。

## 阶段 0：冻结边界和已有能力

- [x] **0.1 明确三项需求和非目标**
  - 状态：DONE
  - 这一步到底做什么：把 Spec003 限定为 Workspace 配置启动、配置端口处理、已有代理接入。
  - 做完能看到什么：README、requirements、design、tasks 对范围和“不做什么”说法一致。
  - 依赖：无。
  - 开始前先看：本目录四份主文档、终端 PTY 调用说明、现有 CodingNS 代理功能。
  - 主要文件：本目录 `README.md`、`requirements.md`、`design.md`、`tasks.md`。
  - 明确不做：不写新的进程编排、端口租约、日志、AI 或代理引擎。
  - 验证：已执行 `git diff --check`；`pnpm exec tsc --noEmit` 通过；现有测试 288/288 通过；四份主文档已逐项检查为三条真实需求。

- [x] **0.2 确认前置能力调用边界**
  - 状态：DONE
  - 这一步到底做什么：确认 Spec003 只调用现有 `terminalProcess/*` 和 CodingNS 反向代理，不复制 backend 或父仓库私有实现。
  - 做完能看到什么：调用说明能明确 `terminal.id` 只 attach，`instance.id` 管理生命周期。
  - 依赖：0.1。
  - 开始前先看：PTY 调用说明、`src/host/features/terminal-process.ts`、现有代理模块。
  - 主要文件：终端调用说明、设计文档。
  - 明确不做：不新增 `runtimeMode=process`。
  - 验证：`pnpm test -- tests/terminal-process.spec.ts` 通过；`pnpm exec tsc --noEmit` 通过；Spec003 定向测试通过。

## 阶段 1：Workspace 配置和终端启动

- [x] **1.1 实现 Workspace 配置文件读写和校验**
  - 状态：DONE
  - 这一步到底做什么：读取和保存 `.codingns/debug.json`，校验版本、配置项、相对目录、命令、参数、终端和端口。
  - 做完能看到什么：Host 能列出配置项；格式错误、绝对路径和越界目录会被拒绝。
  - 依赖：0.1、0.2。
  - 开始前先看：`requirements.md` 需求 1、`design.md` §2、现有 Workspace 解析和终端 Profile 契约。
  - 主要文件：`src/shared/contracts/`、`src/host/` 配置模块、定向测试。
  - 明确不做：不建立 Storage Domain、多版本历史或 worktree 继承。
  - 验证：`node --test tests/debug-workspace.spec.ts` 通过；`pnpm exec tsc --noEmit` 通过。

- [x] **1.2 接入已有 PTY 启动器**
  - 状态：DONE
  - 这一步到底做什么：按配置项调用现有 `terminalProcess/launch`，返回运行实例和 Terminal attach 信息。
  - 做完能看到什么：用户可按配置启动命令，原生 Terminal 能打开或恢复，停止按 `instance.id` 执行。
  - 依赖：1.1。
  - 开始前先看：PTY 调用说明、`src/host/features/terminal-process.ts`、`tests/terminal-process.spec.ts`。
  - 主要文件：`src/host/rpc.ts` 或对应功能模块、`src/client/` 调试入口、定向测试。
  - 明确不做：不向已有 Shell 注入命令，不重新实现 tmux/local-pty/ConPTY。
  - 验证：`pnpm test -- tests/terminal-process.spec.ts` 及 `node --test tests/debug-workspace.spec.ts` 通过；`pnpm exec tsc --noEmit` 通过。

## 阶段 2：端口检查和安全结束

- [x] **2.1 检查配置端口**
  - 状态：DONE
  - 这一步到底做什么：Host 根据配置端口返回未监听或监听进程摘要。
  - 做完能看到什么：页面能显示端口状态和检查时间，不接受 Client 任意端口。
  - 依赖：1.1。
  - 开始前先看：`requirements.md` 需求 2、`design.md` §4、平台进程适配现有代码。
  - 主要文件：`src/host/` 端口观察模块、共享契约、定向测试。
  - 明确不做：不做端口租约、端口池或后台巡检平台。
  - 验证：`node --test tests/debug-workspace.spec.ts` 的端口检查测试通过；`pnpm exec tsc --noEmit` 通过。

- [x] **2.2 用户确认后结束监听进程**
  - 状态：DONE
  - 这一步到底做什么：用短时检查结果作为确认凭据，执行前重新核验端口、PID 和启动身份，再结束对应进程。
  - 做完能看到什么：身份一致时成功，端口复用或身份变化时安全拒绝。
  - 依赖：2.1。
  - 开始前先看：`requirements.md` 需求 2 验收标准 3～6、`design.md` §4。
  - 主要文件：`src/host/` 端口结束模块、错误码、定向测试。
  - 明确不做：不允许 Client 直接传 PID，不因插件卸载或 Session 切换杀进程。
  - 验证：`node --test tests/debug-workspace.spec.ts` 已覆盖身份变化拒绝和身份一致结束；`pnpm exec tsc --noEmit` 通过。

## 阶段 3：复用已有反向代理

- [ ] **3.1 将运行实例绑定到现有代理**
  - 状态：IN_REVIEW
  - 这一步到底做什么：端口确认监听后，调用 CodingNS 已有反向代理服务创建绑定；停止或身份变化时撤销绑定。
  - 做完能看到什么：配置启用代理的服务可通过 Host 返回的代理入口访问，旧实例停止后入口失效。
  - 依赖：1.2、2.1；现有代理接口必须可调用。
  - 开始前先看：`requirements.md` 需求 3、`design.md` §5、现有 CodingNS 代理实现和测试。
  - 主要文件：`src/host/` 代理绑定 RPC、共享契约、定向测试。
  - 明确不做：不实现 HTTP/SSE/WebSocket 转发器，不允许任意 URL 或任意端口。
  - 验证：已完成代理绑定前置条件 Fake 测试；真实 CodingNS 代理适配器尚未注入，不能标记 DONE。

- [ ] **3.2 提供最小 DSH 调试入口**
  - 状态：TODO
  - 这一步到底做什么：提供配置项列表、启动/停止、端口检查/确认结束和代理入口展示。
  - 做完能看到什么：用户无需手写 RPC 即可完成三条主链路；无 Workspace、加载、失败和旧 generation 有明确状态。
  - 依赖：1.2、2.2、3.1。
  - 开始前先看：现有 Client feature 和 DSH 侧栏接口调查文档。
  - 主要文件：`src/client/` 调试页面和功能注册、定向测试。
  - 明确不做：不复制 DSH 布局，不在 Client 读取文件、扫描端口或保存 PID。
  - 验证：页面交互定向测试、`pnpm exec tsc --noEmit`；需要时补浏览器人工证据。

## 阶段 4：验收

- [ ] **4.1 三条主链路最小验收**
  - 状态：TODO
  - 这一步到底做什么：用一个 Workspace 配置验证启动、端口检查、用户确认结束和代理访问/失效。
  - 做完能看到什么：每条需求都有测试或人工记录，未完成项和平台限制明确写入验收文档。
  - 依赖：1.2、2.2、3.2。
  - 开始前先看：本 Spec 全部文档和相关定向测试。
  - 主要文件：`tests/`、`specs/.../docs/` 验收记录。
  - 明确不做：不把 mock 结果写成跨平台完成，不启动未获用户要求的开发服务器。
  - 验证：`pnpm exec tsc --noEmit`、相关定向测试、`pnpm test -- tests/terminal-process.spec.ts`、`git diff --check`。

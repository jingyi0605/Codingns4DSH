# 设计文档 - 工作区调试面板与外部仓库运行编排

状态：Draft，等待方案评审。

## 1. 概述

### 1.1 目标

- 使用 DSH 正式扩展接口增加右侧栏调试页面，不修改 DSH 核心
- 用 Workspace 作为配置、运行、端口、代理和 AI 补丁的统一归属边界
- 在 Host 建立独立进程服务，终端只做可选交互入口
- 完整移植父仓库 `spec007.1` 的框架分析、worktree 继承、启动适配、端口租约和 AI 兜底
- 增加与运行绑定的 HTTP、SSE、WebSocket 反向代理

### 1.2 覆盖需求

- `requirements.md` 需求 1～4：侧栏页面、Workspace 数据和进程基础服务
- `requirements.md` 需求 5～9：完整外部仓库调试编排
- `requirements.md` 需求 10：反向代理
- `requirements.md` 需求 11：隔离与安全边界

### 1.3 技术约束

- TypeScript + ESM，所有相对导入显式带 `.js`
- DSH 精确版本 `0.1.6-alpha.2`
- Node.js `>=22.19.0`
- 使用 DSH `ctx.sidebarRightTabs`、`sidebar.right.pane.tab`、Workspace 和 Storage Domain 正式接口
- 不新增未经评审的依赖
- 不修改 DSH 核心或默认 `connection`
- Client 不引用 `node:*` 模块
- refresh token 只留在现有 Host 凭据存储

## 2. 边界和核心判断

### 2.1 Host 到底是什么

本设计中的 Host 是本机 DSH 主进程里运行的插件 Host half。它通过 Cordis `Context` 获得 DSH 服务，并可以使用 Node.js 文件、进程、网络和加密 API。

职责划分如下：

| 承载端 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| Client | 渲染面板、收集表单、发 RPC、展示流式状态 | 不能直接读本机文件、创建或结束进程、监听端口、应用补丁 |
| Host | 校验 Workspace、持久化、分析文件、创建进程、写日志、租端口、应用补丁、反向代理 | 不能信任 Client 提交的绝对路径或运行状态 |
| Control API | 登录、设备和 Host binding | 不保存项目命令，不运行项目进程，不转发项目明文 |
| Relay | 传输加密后的连接数据 | 不理解调试业务，不读取项目 HTTP 明文 |

“所有执行和停止动作收口到 Host”的人话解释：页面上的按钮只是请求。真正按下系统开关、记住启动了谁、以后准确停掉谁的，是本机 DSH 插件后端。

### 2.2 端口可以定位候选进程，但不能单独证明归属

端口扫描能回答“现在是谁监听 5173”，但不能单独回答“这个进程是不是本插件启动的”。因此系统将进程分成三级：

| 归属 | 判断依据 | 用户操作 |
| --- | --- | --- |
| `managed` | 调试面板 Host 创建并登记了 `ProcessInstance` | 直接停止或重启该运行实例 |
| `agent_terminal` | 监听 PID 能追溯到当前 Workspace 的 AI Agent 私有终端和某次命令执行 | 展示来源后停止该命令子树，不结束 Agent 或终端 Shell |
| `discovered` | 只能通过端口得到 PID、命令和进程树，无法证明来源 | 展示详情，用户明确确认后受控结束 |

对于 `discovered`，Host 先返回短期有效的 `ProcessCandidate`。用户确认后，Host 必须重新解析端口并核对 PID、进程启动时间、可执行文件和保护名单。确认前后任何信息变化都使候选失效，避免原进程已经退出、PID 被新进程复用时杀错目标。

因此，端口可以作为用户主动查找进程的入口，但不能直接作为 `kill` 或 `taskkill` 的参数来源。

### 2.3 终端不是进程主数据

调试服务的主链路是 `ProcessRuntime`，不是侧栏 Terminal tab：

- 关闭或刷新浏览器不会结束项目进程
- 终端 tab 消失不会删除 `ProcessInstance`
- DSH 原生终端可用于打开工作目录、观察日志或在支持时附着运行时
- AI Agent 私有终端必须记录 `terminalId`、命令执行 ID、命令根 PID 和启动身份，使 Host 能把监听子进程归到具体命令
- 终端桥尚未成熟时，不影响进程服务、日志和代理的数据模型

开发开始后的第一个兼容性任务会验证 DSH Terminal 创建、定位、输入和关闭接口。当前只完成 Spec，不提前做原型。

## 3. 总体架构

### 3.1 系统结构

```text
DSH 右侧栏 DebugPanel
  -> CodingNS Debug RPC
  -> WorkspaceAccessGuard
  -> DebugOrchestrator
       -> LaunchProfileService / DebugTargetService
       -> FrameworkAnalysisService
       -> LaunchPlanResolver
       -> PortLeaseService
       -> ProcessRuntimeService -> 平台进程适配器 -> 项目进程
       -> ProcessLogStore
       -> RuntimeBindingService
       -> DebugReverseProxy
       -> AiFallbackService
  -> DSH Storage Domain + Host 受控日志/补丁目录
```

Client 不根据零散字段自行推导“能否启动”。Host 返回完整 `LaunchPlan`、阻断原因和运行快照，Client 只渲染并发送用户动作。

### 3.2 模块职责

| 模块 | 职责 | 主要输入 | 主要输出 |
| --- | --- | --- | --- |
| `DebugSidebarFeature` | 注册 `debug` 页面类型和开始页入口 | DSH Client Context | 页面注册 disposer |
| `WorkspaceResolver` | 从 Session 找 Workspace，并在 Host 再次校验 | `sessionId`、`workspaceId` | `WorkspaceScope` |
| `DebugDomain` | 保存工作区配置和小型状态记录 | 领域记录 | DSH Storage Domain 表 |
| `LaunchProfileService` | 启动项 CRUD、复制和版本控制 | 用户输入、Workspace | `LaunchProfile` |
| `ProcessRuntimeService` | 创建、核验、停止、重启和恢复进程 | `ResolvedLaunchCommand` | `ProcessInstance` |
| `ProcessDiscoveryService` | 按端口发现进程、关联 Agent 终端命令并安全结束外部候选 | 端口、进程树、用户确认 | `ProcessCandidate`、结束结果 |
| `ProcessLogStore` | 有界日志文件、游标和清理 | stdout/stderr | 日志片段与索引 |
| `FrameworkAnalysisService` | 按证据识别框架和附加要求 | Workspace 文件、启动项 | `FrameworkAnalysisResult` |
| `LaunchAdapterRegistry` | 按固定顺序构建启动参数 | 框架结果、服务、租约 | `LaunchPlan` |
| `PortLeaseService` | 分配、续租、释放和恢复端口 | 端口池、运行实例 | `PortLease` |
| `RuntimeBindingService` | 对齐租约端口、真实监听和进程身份 | 进程、端口探测 | `RuntimeBinding` |
| `AiFallbackService` | 生成、校验、应用和回滚受限补丁 | 失败上下文、用户确认 | `AiFallbackEdit` |
| `DebugReverseProxy` | 转发到已核验运行绑定 | 代理路由、请求 | HTTP/SSE/WS 响应 |

### 3.3 关键流程

#### 3.3.1 页面加载

1. Client 从侧栏 tab 取得当前 `sessionId`
2. Client Workspace 服务查找包含该 Session 的 `WorkspaceView`
3. Client 以 `sessionId + workspaceId` 请求 Host 快照
4. Host 从自己的 Workspace Registry 校验相同关系和目录
5. Host 返回启动项、分析摘要、活动运行时、租约和代理入口
6. Client 只接收当前 generation、当前 Workspace 的响应

#### 3.3.2 生成启动计划和运行

1. 用户选择一个或多个已登记启动项
2. Host 读取最新启动项版本和框架分析
3. 为每个服务申请端口租约
4. 按 CLI、环境变量、覆盖产物、AI 的顺序解析适配器
5. 校验服务发现、HMR 和 callback 处理是否完整
6. 返回只读 `LaunchPlan` 给用户确认
7. 用户确认后，Host 重新校验计划版本、租约和 Workspace
8. Host 创建 `ProcessInstance`、接好日志后再启动进程
9. Host 探测真实监听并建立 `RuntimeBinding`
10. 需要代理时创建与该绑定绑定的代理路由

#### 3.3.3 停止

1. Client 发送 `processInstanceId`
2. Host 校验 Workspace、实例状态和进程身份指纹
3. Host 请求优雅退出并等待固定时间
4. 超时后只结束该实例的受控进程树
5. Host 写入退出状态并关闭日志写入
6. Host 释放租约、绑定、覆盖产物和代理路由

#### 3.3.4 按端口定位并结束外部进程

1. 用户对占用端口点击“查看进程”
2. Host 查询当前监听 PID、启动身份、命令、目录和父进程链
3. Host 优先使用 Terminal 命令执行记录判断它是否属于当前 Workspace 的 AI Agent 私有终端
4. Host 创建短时 `ProcessCandidate`，返回归属等级、建议停止范围和风险说明
5. 用户明确确认结束
6. Host 重新检查端口仍由相同 PID 和启动身份监听，并排除 DSH Host、Terminal Broker、Agent 主进程和系统关键进程
7. `agent_terminal` 结束对应命令根进程及子树；`discovered` 默认只结束监听进程及其子进程，不扩大到未知父进程组
8. 优雅退出超时后，只有原候选身份仍一致时才执行强制结束

#### 3.3.5 AI 兜底

1. 前三层适配失败，兼容矩阵允许 AI
2. Host 将候选文件收敛到有限白名单并读取受限上下文
3. AI Provider 只返回统一 diff，不直接写文件
4. Host 校验路径、文件哈希、补丁大小和禁止文件
5. Client 展示差异，用户明确确认
6. Host 原子应用并保存逆向补丁和应用后哈希
7. 回滚时只在当前内容仍能安全匹配时应用逆向补丁

#### 3.3.6 代理请求

1. 浏览器访问 `/codingns/debug-proxy/<slug>/...`
2. Host 根据 slug 查找活动 `ReverseProxyRoute`
3. Host 再检查运行实例身份、绑定状态和 Workspace 权限
4. Host 只向 `127.0.0.1` 或 `::1` 的 `observedPort` 建立连接
5. HTTP/SSE 走流式转发，WebSocket 走 Upgrade 双向字节流
6. 运行停止或绑定改变后，原 slug 立即失效

## 4. DSH 接入设计

### 4.1 侧栏页面

注册信息：

```ts
{
  id: 'dsh-codingns/debug',
  kind: 'debug',
  multiple: false,
  title: () => '调试面板',
  guide: {
    id: 'dsh-codingns/debug',
    title: '调试面板',
    description: '管理当前工作区的启动、端口和访问入口',
    order: 30,
  },
}
```

正文通过 `sidebar.right.pane.tab` 注册。布局、分栏、全屏、浮动、折叠和标签恢复完全交给 DSH。

### 4.2 Workspace 解析

Client 使用 DSH Workspace 快照中 `WorkspaceView.sessionIds` 解析当前 Workspace。Host 使用 `ctx.workspaceRegistry` 取得权威 Workspace 路径并重新校验。

不能把 Client 传来的 `workspacePath` 当成可信输入。所有文件路径由 Host 根据权威根目录和 `cwdRelative` 解析。

### 4.3 Storage Domain

定义独立领域：

```text
domain: dsh-codingns-debug
version: 1
```

建议表：

| 表 | 内容 | 持久化策略 |
| --- | --- | --- |
| `launchProfiles` | 启动项 | 长期保存，Workspace 级 |
| `debugTargets` | 调试目标和 worktree 血缘 | 长期保存 |
| `debugServices` | 服务角色和启动项关系 | 长期保存 |
| `frameworkAnalyses` | 有版本和证据摘要的分析结果 | 可刷新覆盖 |
| `processInstances` | 运行历史和活动身份摘要 | 有界保留 |
| `terminalExecutions` | AI Agent 私有终端的活动命令来源和根进程身份 | 活动记录持久化，终态有界保留 |
| `debugRuntimes` | 一次多服务启动记录 | 有界保留 |
| `portLeases` | 活动与近期租约 | 终态定期清理 |
| `runtimeBindings` | 进程、端口和代理关系 | 终态定期清理 |
| `aiFallbackEdits` | 补丁状态、哈希和引用 | 未处理记录长期保留 |
| `reverseProxyRoutes` | slug 与运行绑定关系 | 活动记录，停止即失效 |

键使用 `<workspaceId>:<recordId>`，记录内仍保存 `workspaceId` 并在读取时双重校验。Storage Domain 写入完成后才更新内存和发布事件。

日志正文和大型补丁不写进 KV 记录。它们写入 Host 的插件受控数据目录，Storage Domain 只保存文件引用、哈希、字节数和保留时间。正式开发前必须确认 DSH 提供的稳定数据目录；没有正式目录就阻止实现，不能写进 Workspace 或临时目录假装持久化。

### 4.4 RPC 和状态流

在现有 `codingns` RPC 下增加：

```text
debug/snapshot
debug/profile/list|create|update|delete|clone
debug/analysis/get|refresh|matrix
debug/plan/create|discard
debug/runtime/start|get|list|stop|restart
debug/process/inspect-port|terminate-candidate
debug/log/read|follow
debug/ai/preview|apply|reject|rollback|keep
debug/proxy/get|enable|disable
debug/settings/get|set
```

所有变更请求包含：

```text
sessionId
workspaceId
expectedRevision 或 expectedUpdatedAt
目标记录 ID
```

高频日志和运行事件不得轮询整个快照，应使用 DSH 可取消的流或现有连接事件能力。每个订阅都绑定 generation、Workspace 和 AbortSignal。

## 5. 数据结构

### 5.1 `LaunchProfile`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 启动项 ID |
| `workspaceId` | string | 工作区 |
| `name` | string | 展示名称 |
| `cwdRelative` | string | 相对 Workspace 根目录 |
| `command` | string | 可执行文件或明确 Shell 命令 |
| `args` | string[] | 参数数组，不与命令拼成一条字符串保存 |
| `env` | Record<string, string> | 非秘密环境变量；秘密引用单独处理 |
| `shellPath` | string \| null | 可选 Shell |
| `runtimeMode` | `process` \| `pty` | 无交互进程或可附着 PTY |
| `serviceRole` | `frontend` \| `backend` \| `worker` \| `mock` \| `custom` | 服务角色 |
| `defaultPortHint` | number \| null | 默认端口提示 |
| `protocol` | `http` \| `https` \| `tcp` \| `none` | 服务协议 |
| `healthPath` | string \| null | 可选健康路径 |
| `proxy` | `ProxyTemplate` | 代理配置 |
| `sourceProfileId` | string \| null | worktree 继承来源 |
| `revision` | number | 乐观并发版本 |
| `createdAt/updatedAt` | string | 时间 |

环境变量值默认作为普通配置处理，但字段名命中 `TOKEN`、`SECRET`、`PASSWORD`、`KEY` 等规则时禁止持久化明文，只允许保存 Host 侧秘密引用或要求运行前输入。

### 5.2 `ProcessInstance`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 运行实例 ID |
| `workspaceId/profileId/runtimeId/serviceId` | string | 归属关系 |
| `state` | string | `PREPARING/STARTING/RUNNING/STOPPING/EXITED/FAILED/LOST` |
| `pid` | number \| null | 平台 PID，仅作身份的一部分 |
| `processFingerprint` | string \| null | 启动时间、PID、命令摘要或 broker identity 组合 |
| `processGroupRef` | string \| null | 受控进程树或 Windows broker 引用 |
| `resolvedCommand` | object | 实际命令、参数和脱敏环境摘要 |
| `logRef` | string | Host 日志索引引用 |
| `exitCode/signal/error` | nullable | 终态信息 |
| `startedAt/stoppedAt` | string \| null | 时间 |

### 5.2.1 Agent 终端执行和外部进程候选

`TerminalCommandExecution` 记录 AI Agent 私有终端中一次命令的来源：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `executionId` | string | 命令执行 ID |
| `terminalId` | string | 私有终端 ID |
| `workspaceId` | string | 工作区 |
| `commandSummary` | string | 脱敏命令摘要 |
| `rootPid` | number | 该命令的根进程 |
| `rootStartToken` | string | 防止 PID 复用的启动身份 |
| `startedAt/finishedAt` | string \| null | 时间 |

`ProcessCandidate` 是不持久化的短时确认对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 随机候选 ID |
| `workspaceId` | string | 发起检查的工作区 |
| `port` | number | 被检查的监听端口 |
| `pid` | number | 检查时的监听进程 PID |
| `processStartToken` | string | 执行前必须重新匹配 |
| `executable/commandLine/cwd` | nullable | 用户确认信息 |
| `parentTree` | array | 有界父进程链 |
| `ownership` | `agent_terminal/discovered` | 归属等级 |
| `terminalId` | string \| null | Agent 私有终端证据 |
| `executionId` | string \| null | Agent 命令执行证据 |
| `commandRootPid` | number \| null | 建议结束的命令根进程 |
| `suggestedScope` | `command_tree/listener_tree` | 建议停止范围 |
| `expiresAt` | string | 短期有效期 |

候选只保存在 Host 内存，不能由 Client 自己构造。`terminate-candidate` 只接受候选 ID 和确认意图，不接受 Client 提交的新 PID。

### 5.3 调试编排模型

`DebugTarget`、`DebugService`、`FrameworkAnalysisResult`、`DebugRuntime`、`PortLease`、`RuntimeBinding` 和 `AiFallbackEdit` 保留父仓库 `spec007.1` 的职责，但作以下调整：

- 目录字段只保存 Workspace 相对路径
- `DebugService` 必须引用已登记 `LaunchProfile`
- `RuntimeBinding` 必须同时引用 `ProcessInstance` 和 `processFingerprint`
- `observedPort` 只能由 Host 探测得出
- `proxyRouteId` 只在监听验证成功后创建
- AI 补丁保存内容哈希和文件引用，不把大补丁塞进普通快照

### 5.4 `ReverseProxyRoute`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 路由 ID |
| `workspaceId` | string | 工作区 |
| `runtimeBindingId` | string | 唯一上游来源 |
| `slug` | string | 随机、不可猜的 URL 段 |
| `mode` | `path-prefix` | 当前只支持路径前缀模式 |
| `basePath` | string | `/codingns/debug-proxy/<slug>/` |
| `rewriteHtml` | boolean | 是否对有界 HTML 响应做路径改写 |
| `webSocket` | boolean | 是否允许 Upgrade |
| `state` | `ACTIVE/DISABLED/STALE` | 状态 |
| `createdAt/disabledAt` | string \| null | 时间 |

路由不保存任意上游 URL。实际目标每次从活动 `RuntimeBinding` 解析为回环地址和 `observedPort`。

## 6. 进程、端口和日志

### 6.1 平台运行适配器

统一接口：

```ts
interface ProcessRuntimeAdapter {
  start(input: ProcessStartInput): Promise<OwnedProcessHandle>
  inspect(handle: OwnedProcessHandle): Promise<OwnedProcessSnapshot>
  stop(handle: OwnedProcessHandle, options: StopOptions): Promise<StopResult>
  attach?(handle: OwnedProcessHandle): Promise<ProcessAttachment>
}
```

实现必须覆盖：

- POSIX：独立进程组、PID 启动时间核验、SIGTERM 到 SIGKILL 两阶段停止
- Windows：使用可核验的 broker、Job Object 或等价受控进程树机制，不能只靠 `taskkill` 加端口 PID
- 测试：Fake adapter，不启动真实外部服务

是否复用现有 `tmux-backend` 或将其只用于 PTY 模式，在终端兼容任务中决定。主接口不能被 tmux 命令格式绑死。

### 6.2 端口状态

页面状态使用下面的明确语义：

| 状态 | 含义 | 可否停止 |
| --- | --- | --- |
| `UNCONFIGURED` | 服务不需要或没有端口 | 仅当存在受控进程实例时可停止实例 |
| `AVAILABLE` | 候选端口当前空闲 | 否 |
| `LEASED` | 已租给本次运行，尚未验证监听 | 可停止对应受控实例 |
| `LISTENING_OWNED` | 端口监听者与登记进程身份匹配 | 可停止对应受控实例 |
| `OCCUPIED_EXTERNAL` | 端口被未知或其他实例占用 | 可查看进程；用户确认并通过执行前复核后可结束候选进程 |
| `MISMATCH` | 进程运行但监听端口与计划不同 | 可停止对应受控实例，不可按端口杀进程 |

### 6.3 日志

- stdout 和 stderr 保留来源标记和单调递增游标
- 写入采用有界文件分段，避免无限内存和巨型 KV 记录
- 读取支持 `afterCursor + limitBytes`
- 日志中对已知环境变量秘密值做替换
- 超限时删除最老终态日志，活动日志不能被无提示截断

### 6.4 外部进程发现与保护规则

- 端口探测得到 PID 后必须读取启动时间或平台等价身份，不能只保存 PID
- 通过进程祖先链将监听 PID 与 `TerminalCommandExecution` 匹配；daemonize 后失去祖先关系的进程降级为 `discovered`
- `agent_terminal` 的停止范围是该次命令根进程及子树，不包括终端 Shell 和 Agent 主进程
- `discovered` 默认只结束监听进程及子进程；扩大到父进程组必须有额外证据和单独确认
- DSH Host、插件 Supervisor、Terminal Broker、当前 Agent 主进程、PID 1、系统关键进程及其他操作系统用户的进程进入保护名单
- 结束流程先优雅退出，强制阶段前再次复核相同启动身份

## 7. 框架分析和启动适配

### 7.1 分析规则

分析器只读取有限的清单、锁文件、框架配置和已登记启动项。它输出证据，不自动创建运行命令。

兼容等级：

- `supported`：官方覆盖方式明确，可自动生成计划
- `conditional`：需要额外服务发现、HMR、callback 或仓库写法验证
- `unsupported`：当前适配器不支持，不自动注入
- `unknown`：证据不足，不自动注入

具体矩阵见 `docs/20260922-框架兼容矩阵.md`。

### 7.2 适配器顺序

```text
CliPortAdapter
  -> EnvPortAdapter
  -> RuntimeOverrideAdapter
  -> AiFallbackAdapter
```

每次尝试都写入 `AdapterAttempt`：适配器、是否匹配、生成内容摘要、失败阶段和下一步。禁止静默跳层。

### 7.3 服务联动

- 前端到后端：优先使用同源代理路径，其次注入受控 `API_BASE_URL`
- HMR：校验 WebSocket path、client port 和代理 Upgrade
- callback：默认只提示并列出新 URL；除非适配器有明确配置入口，否则不自动修改第三方后台
- 多服务：启动计划显式保存依赖顺序；后端未就绪时前端可启动但状态必须显示“依赖未就绪”

### 7.4 worktree 继承

Host 使用 Git 正式命令或仓库元数据识别 worktree common dir 和根目录。继承必须由用户预览确认，避免错误仓库自动复制。

复制规则：

- 复制启动项配置和服务关系
- 将工作目录映射为目标 Workspace 下相同相对路径
- 不复制运行记录、租约、日志、代理 slug 和 AI 补丁
- 新记录保存 `sourceProfileId`，后续不做隐式双向同步

## 8. AI 兜底安全设计

### 8.1 Provider 边界

定义 `AiPatchProvider`，输入只能是：

- 失败的适配器摘要
- 目标端口和服务关系
- 有限候选文件内容
- 明确禁止项和期望统一 diff 格式

Provider 不获得 Host token、refresh token、完整环境变量、Workspace 外文件或无限制工具权限。

正式实现必须使用 DSH 提供并经过确认的 Agent/模型调用接口；不能私自调用未知外部模型服务。若 DSH 当时仍无稳定接口，该任务标记 `BLOCKED`，但不得把“只记录 AI 请求”冒充完整实现。

### 8.2 应用和回滚

- 生成补丁与应用补丁分成两个 RPC
- 应用前重新计算每个文件哈希
- 临时文件写完并 `fsync` 后原子替换
- 保存正向和逆向补丁、应用前后哈希、文件列表和用户确认时间
- 回滚发现用户后续修改时停止并展示冲突，不覆盖用户内容
- 禁止使用破坏性 Git 命令实现回滚

## 9. 反向代理设计

### 9.1 安全边界

代理目标不是用户输入的 URL，而是以下关系的计算结果：

```text
slug -> ReverseProxyRoute -> RuntimeBinding -> ProcessInstance + observedPort
```

每次请求必须确认：

- route 为 `ACTIVE`
- binding 为 `LISTENING`
- process identity 仍与登记实例一致
- 地址是回环地址
- 端口等于绑定的 `observedPort`

任何一项失败都返回明确的 404、409 或 502，并使陈旧路由失效。

### 9.2 协议处理

- HTTP：透传常用方法、查询参数和流式请求体
- SSE：禁止整包缓冲，保持流式刷新
- WebSocket：透传 Upgrade 和双向字节流，任一端关闭即清理另一端
- Header：移除 hop-by-hop header，重写 Host、Origin、Location 和必要的 Cookie Path
- 压缩：需要改写的有界文本响应请求 identity 编码；不改写的响应保持流式
- HTML：只在内容类型、编码和大小符合限制时改写根路径资源引用并注入代理上下文
- JavaScript/CSS：不做无边界正则替换；优先通过代理上下文、框架适配器和 HMR 配置解决

父仓库对任意 HTML/JS/CSS 文本做字符串改写的方式只能作为兼容参考，不能直接照搬。

### 9.3 与现有 `reverseProxy` 设置模块的关系

当前插件的 `reverseProxy` 功能名实际表示“CodingNS 中转访问服务”，不是项目反向代理。为避免破坏已有设置：

- 保留现有 `modules.reverseProxy` 键和“中转访问服务”行为
- 新功能内部命名为 `debugServiceProxy`
- 调试服务代理由调试面板配置，不占用现有设置卡片语义
- 后续若重命名旧键，必须另做兼容迁移，不能在本 Spec 偷换含义

## 10. 错误处理

主要错误码：

```text
DEBUG_WORKSPACE_REQUIRED
DEBUG_WORKSPACE_FORBIDDEN
DEBUG_PATH_OUTSIDE_WORKSPACE
DEBUG_PROFILE_CONFLICT
DEBUG_FRAMEWORK_UNSUPPORTED
DEBUG_LAUNCH_PLAN_STALE
DEBUG_PORT_POOL_EXHAUSTED
DEBUG_PORT_OCCUPIED_EXTERNAL
DEBUG_PROCESS_CANDIDATE_STALE
DEBUG_PROCESS_TERMINATION_CONFIRMATION_REQUIRED
DEBUG_PROCESS_PROTECTED
DEBUG_PROCESS_IDENTITY_MISMATCH
DEBUG_PROCESS_NOT_RUNNING
DEBUG_AI_FALLBACK_NOT_ALLOWED
DEBUG_AI_PATCH_CONFLICT
DEBUG_PROXY_TARGET_STALE
DEBUG_PROXY_UPSTREAM_FAILED
```

错误响应继续使用现有 CodingNS RPC 结果形状。内部日志可以包含实例 ID 和阶段，但不能记录秘密值、完整补丁或 refresh token。

## 11. 正确性属性

### 11.1 Workspace 隔离

对于任何记录和 RPC，Host 权威 Workspace 与记录 `workspaceId` 不一致时，操作必须失败。

### 11.2 进程所有权

对于调试面板管理的进程，停止必须通过 `ProcessInstance` 身份核验。对于端口发现的外部进程，只有用户明确确认、候选未过期、执行前身份复核通过且不在保护名单时才能结束；端口号本身永远不足以授权结束。

### 11.3 租约唯一性

任何时刻，同一 Host、协议和端口最多有一个活动租约；外部占用不能被租约覆盖。

### 11.4 代理绑定

代理只在进程身份、运行绑定和真实监听三者一致时可用；端口被后来进程复用时旧路由仍必须失效。

### 11.5 AI 可逆性

AI 补丁只有在文件哈希与预览时一致时才能应用；回滚不能覆盖补丁应用后的用户修改。

### 11.6 generation 隔离

旧 generation 的快照、日志、端口探测、分析和代理状态不得写入新 generation 的 Client store。

## 12. 测试策略

### 12.1 单元测试

- 所有 DTO 解析、路径边界、秘密字段、状态机和错误码
- 框架识别、兼容矩阵和适配器顺序
- 端口租约原子分配、回收和耗尽
- 进程身份核验和未知端口占用
- AI Agent 私有终端命令归属、候选过期、PID 复用、保护进程和二次确认
- AI 补丁白名单、哈希冲突和回滚
- 代理 URL、Header、Cookie、Location 和大小限制

### 12.2 集成测试

- Fake Workspace Registry + Storage Domain 的跨 Workspace 隔离和 Host 重启恢复
- Fake Process Adapter 的启动、失败、停止、重启和补偿
- 按端口发现后在确认前替换监听进程，验证旧候选不能结束新 PID
- Fake port probe 的租约、外部冲突和监听不一致
- HTTP、SSE、WebSocket 本机测试上游
- Session/generation 切换时旧订阅失效

### 12.3 平台测试

- macOS：进程组、端口探测、日志、HTTP/WS 代理
- Linux：同上，并覆盖 `ss` 可用和不可用路径
- Windows：broker/Job Object、PowerShell/cmd、端口探测、进程树停止和 WebSocket

### 12.4 真实 DSH 验收

- 开始页入口、标签、分栏、浮动、全屏、折叠和恢复
- 同 Workspace 多 Session 共享数据
- 两个 Workspace 或 worktree 并行启动同类项目
- Vite HMR、一个 SSE 服务和一个后端 API 通过代理访问
- 浏览器刷新、Client 重载、generation 切换和 Host 重启
- AI 补丁预览、确认、冲突和回滚

每个实现任务完成后运行：

```bash
pnpm exec tsc --noEmit
pnpm test -- tests/debug-*.spec.ts
```

最终再运行完整 `pnpm test`。按项目规则，不主动启动开发服务器；真实联调由用户明确要求时执行。

## 13. 风险与待确认项

### 13.1 风险

- DSH `0.1.6-alpha.2` 的 Terminal 页面导航不直接返回新 tab ID，需要开发开始后先验证稳定接入方式
- DSH 是否提供插件稳定数据目录和 Host Web Server Upgrade 扩展点，需要用安装版类型和运行行为确认
- Windows 的跨 Host 重启进程身份恢复不能只靠 PID，可能需要独立 broker
- 路径前缀代理无法自动兼容所有生成绝对 URL 的框架，必须由兼容矩阵明确标注
- DSH Agent/模型调用接口若不稳定，AI 完整实现会成为真实外部依赖
- 私有终端若只能写入原始按键、不能提供命令执行和根 PID 事件，Agent 启动进程只能降级为 `discovered`，不能伪造 `agent_terminal` 归属

### 13.2 已确定的处理方式

- 本轮只完成 Spec，不执行 Terminal 原型
- 开发阶段先验证 DSH 正式接口，再冻结共享契约
- 任何接口验证失败都回写 `tasks.md`，不得用 DOM 补丁、私有字段或猜测时间差绕过
- 用户要求完整实现父仓库 `spec007.1` 和反向代理，因此 AI 应用/回滚、worktree、服务联动、HMR 和 WebSocket 均属于交付范围，不再标记为“以后再做”

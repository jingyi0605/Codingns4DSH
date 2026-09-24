# 任务清单 - DeepSeek Harness 的 CodingNS 单一插件（人话版）

状态：阶段 0 骨架和发行装配已完成；用户定义阶段 1～4 已有实现记录；真实 Transport、远程 Web Runtime、多 Host 和 H5/Desktop 联调仍未完成。

## 阶段 0：插件骨架与契约

- [x] 0.1 确认 DSH 插件包结构与启动期 Transport 装配
  - 状态：DONE
  - 已完成：读取 DSH `ddefc45fbc7f8e46dd73185e68295696d1297887` 的 manifest、Bundle、Profile、Client module 和 Connection 源码，并用本机 `dsh 0.1.6-alpha.2` 临时 Profile 回放 Bundle 识别。
  - 采用方案：独立 CodingNS Profile + `engines.dsh` 精确锁定 + `dsh-codingns/bootstrap` pre-Cordis 启动胶水 + `dsh-codingns` Bundle。普通动态插件不覆盖默认 Connection。
  - 验证命令：`git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD refs/heads/master`、`dsh --version`、临时 `DSH_HOME dsh plugin --profile stage0 add ...`、`dsh --profile stage0 --dump-config`、`pnpm test -- tests/manifest.spec.ts tests/bootstrap.spec.ts`；结果已写入 `docs/20260921-阶段0-DSH插件装配调查.md`。

- [x] 0.2 建立插件包骨架
  - 状态：DONE
  - 结果：`dsh-codingns` package manifest、Bundle patch、Host/Client/Shared 出口、`./bootstrap` 出口和独立 Profile 已创建。根据 DSH `0.1.6-alpha.2` 的 Client Loader 实际实现，`exports["./client"]` 使用 `default` 条件指向浏览器构建产物，确保 Web boot graph 能发现 Client entry。
  - 验证命令：`pnpm test -- tests/manifest.spec.ts tests/client-entry.spec.ts`；结果：6 个定向测试通过。

- [x] 0.3 建立 Host / Client 双入口
  - 状态：DONE
  - 结果：包根 Host 空入口和 `exports["./client"]` 浏览器空入口均无网络、凭据或异步资源。
  - 验证命令：`pnpm test -- tests/host-entry.spec.ts tests/client-entry.spec.ts`；结果：通过。

- [x] 0.4 建立共享类型契约
  - 状态：DONE
  - 结果：配置、Feature、Transport、PeerHost、ResourceScopeRef 和统一错误码已建立；未实现业务流程。
  - 验证命令：`pnpm test -- tests/contracts.spec.ts`、`pnpm exec tsc --noEmit`；结果：通过。

- [x] 0.5 建立 Host / Client 依赖边界
  - 状态：DONE
  - 结果：边界记录在 `docs/20260921-阶段0-Host与Client边界.md`；Client 构建产物 Node 专属模块检查通过。
  - 验证命令：`pnpm test -- tests/client-entry.spec.ts`；结果：通过。

- [x] 0.6 建立最小 Bundle 和 Profile
  - 状态：DONE
  - 结果：Bundle 使用真实 `dsh.bundle.patch` 结构，独立 Profile 使用真实 `dsh.profile.bundles` 结构并精确锁定 `dsh-codingns@0.1.0` 和 DSH `0.1.6-alpha.2`；没有注入未实现业务。
  - 验证命令：`pnpm test -- tests/manifest.spec.ts`；结果：通过。

- [x] 0.7 阶段 0 最小测试与兼容错误
  - 状态：DONE
  - 结果：manifest、契约、Host/Client 加载卸载、Client Node 依赖扫描、启动胶水生命周期和 DSH 版本错误测试均通过。
  - 验证命令：`pnpm test -- tests/manifest.spec.ts tests/contracts.spec.ts tests/host-entry.spec.ts tests/client-entry.spec.ts tests/bootstrap.spec.ts`、`pnpm exec tsc --noEmit`；结果：13 个定向测试通过，类型检查通过。

阶段 0 结论：插件骨架、契约和三件套发行装配已完成。现有阶段 1 至 4 的实现记录保留；真实远端 WebRTC/DSH 联调、HostRouter、远程 Web Runtime 和业务模块仍未完成。

## 这份文档是干什么的

这份清单把阶段二拆成可以独立验收的步骤。阶段 0 的任务已在本文件顶部回写；后续任务仍按实际验证结果更新，不能用“代码已写”代替验收。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写状态
- `CANCELLED`：取消，不做了，但要写原因

## 阶段 1：先把单一插件和连接骨架定下来

- [x] 1.1 确认 DSH 启动期 Transport 装配入口
  - 状态：DONE（装配方式已确定，真实 Transport 尚未实现）
  - 这一步到底做什么：确认 `ClientTransportHooks`、`installConnection()`、Profile、client entry、Host entry 和 pre-Cordis 启动胶水的装配方式。
  - 做完你能看到什么：一份可运行的最小启动胶水配置，能证明外部提供的 Transport 在默认 Connection 之前登记；真实 CodingNS Transport 仍属于后续任务。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1、需求 3
    - `design.md` §1.3「技术约束」
    - `design.md` §2.1「系统结构」
  - 主要改哪里：
    - `packages/` 或 DSH Profile 集成目录
    - `docs/` 启动期装配记录
  - 这一步先不做什么：不实现文件、终端、进程和反向代理功能。
  - 怎么算完成：
    1. Host entry 和 Client entry 都能被 DSH 识别。
    2. Transport 注入时序和版本兼容约束已经写清楚。
    3. 启动胶水对重复登记、启动失败和版本不匹配有测试证据。
  - 怎么验证：
    - DSH 最小 Profile 启动测试
    - `pnpm test -- tests/manifest.spec.ts tests/bootstrap.spec.ts`
    - 手工确认启动胶水先登记 Transport，再交给 DSH Client 启动
  - 对应需求：`requirements.md` 需求 1 / 验收 1.1、1.2
  - 对应设计：`design.md` §2.1、§3.1

- [x] 1.2 建立控制站客户端和凭据边界
  - 状态：DONE
  - 这一步到底做什么：实现控制站登录、刷新、设备、Host binding 和 signaling ticket 的 Host 侧客户端，并接入 Host 凭据存储。
  - 做完你能看到什么：登录后 refresh token 只存在 Host，Client 可以拿到不含敏感凭据的账号和 Host 摘要。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 2、需求 8
    - `design.md` §2.3.1「登录和 Host 绑定」
    - `design.md` §3.2.1「CodingNsDshConfig」
  - 主要改哪里：
    - `src/host/control-api-client.*`
    - `src/host/credential-store.*`
    - `src/host/auth-session.*`
  - 这一步先不做什么：不建立 WebRTC DataChannel，不实现远程 DSH RPC。
  - 怎么算完成：
    1. 登录、刷新、退出和撤销设备的错误码稳定。
    2. 日志和测试中不存在密码、refresh token 和完整 ticket。
  - 怎么验证：`pnpm test -- tests/auth.spec.ts`；结果：6 个子测试通过。
  - 对应需求：`requirements.md` 需求 2、需求 8
  - 对应设计：`design.md` §2.3.1、§3.1、§5

### 阶段检查

- [x] 1.3 连接骨架检查
  - 状态：DONE
  - 这一步到底做什么：确认插件的启动入口、控制站客户端和凭据边界已经站稳。
  - 做完你能看到什么：可以在不加载业务功能模块的情况下启动插件并完成登录状态初始化。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md` §2、§3、§4
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不加新功能，不绕开 DSH Connection 机制。
  - 怎么算完成：
    1. 启动、登录、退出和配置校验都有测试证据。
    2. 所有未完成风险已经记录在 `design.md` §8。
  - 怎么验证：`pnpm test -- tests/bootstrap.spec.ts tests/auth.spec.ts`、`pnpm exec tsc --noEmit`；结果：通过。

## 阶段 2：打通 WebRTC 到 DSH 的完整远程连接

- [x] 2.1 实现信令、WebRTC 和指纹校验
  - 状态：IN_REVIEW（浏览器侧 Fake/接口注入已通过；真实 Host/Relay 联调未完成）
  - 这一步到底做什么：实现 Relay Signaling ticket、ICE/TURN、DataChannel 和 Host fingerprint 校验。
  - 做完你能看到什么：Client 可以建立一个已经完成身份校验的 CodingNS DataChannel。
  - 先依赖什么：1.3
  - 开始前先看：
    - `requirements.md` 需求 3
    - `design.md` §2.3.2「codingns connect 建立远程 DSH 连接」
    - `design.md` §3.2.3「TunnelFrame」
  - 主要改哪里：
    - `src/transport/signaling-client.*`
    - `src/transport/webrtc-carrier.*`
    - `src/transport/fingerprint-verifier.*`
  - 这一步先不做什么：不把业务数据直接交给 Relay，不实现功能 UI。
  - 怎么算完成：
    1. 指纹不匹配时连接不能进入 ready。
    2. DataChannel 关闭时所有等待中的连接操作都会收到明确错误。
  - 怎么验证：
    - fake signaling 和 fake WebRTC 单元测试
    - 本地 Control API、Relay 和 Host/Client 联调
  - 对应需求：`requirements.md` 需求 3 / 验收 3.1、3.2
  - 对应设计：`design.md` §2.3.2、§5.1

- [x] 2.2 实现 Tunnel Multiplexer 和 DSH Transport Provider
  - 状态：IN_REVIEW（帧复用和 hooks 骨架已通过；生产级背压和真实 DSH generation loop 未联调）
  - 这一步到底做什么：把 RPC、Fetch、Stream、事件、取消和背压编码到 DataChannel，并接入 DSH `ClientTransportHooks`。
  - 做完你能看到什么：远程 DSH 能执行一次 unary RPC、一个 Remote stream 和一个文件流。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 3、需求 8
    - `design.md` §2.3.3「断线恢复」
    - `design.md` §3.3.2「DSH Transport」
    - `design.md` §6.1「旧 generation 不得污染新 generation」
  - 主要改哪里：
    - `src/transport/tunnel-multiplexer.*`
    - `src/transport/dsh-transport-provider.*`
    - `src/host/dsh-forwarder.*`
  - 这一步先不做什么：不新增私有重连调度器，不改 DSH Remote 的领域协议。
  - 怎么算完成：
    1. 大消息按帧传输，窗口耗尽时发送端会暂停。
    2. 旧 generation 的响应不能进入新 generation。
    3. `loadBundle`、文件上传和取消有单独测试。
  - 怎么验证：
    - 编解码、乱序、取消、背压和超时测试
    - DSH Connection 集成测试
  - 对应需求：`requirements.md` 需求 3、需求 8
  - 对应设计：`design.md` §2.3.3、§3.2.3、§3.3.2、§6.1

- [ ] 2.3 实现断线恢复和 generation 替换
  - 状态：TODO
  - 这一步到底做什么：复用 DSH Connection recovery，确保 DataChannel、Remote mux 或事件流断开后能重新连接并恢复状态。
  - 做完你能看到什么：断网后 Client 显示重连状态，连接恢复后文件树和终端不会收到旧连接的延迟数据。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 3、非功能需求 2
    - `design.md` §2.3.3、§4.2
  - 主要改哪里：
    - `src/transport/recovery.*`
    - `src/client/connection-state.*`
  - 这一步先不做什么：不为终端或文件模块分别创建私有重连系统。
  - 怎么算完成：
    1. 每次重试都替换物理载体和 generation。
    2. 未恢复的流会明确结束或按模块协议恢复。
  - 怎么验证：
    - 模拟断网、Relay 断开、ticket 过期和 Host 重启
    - generation 快照与流恢复测试
  - 对应需求：`requirements.md` 需求 3、需求 8
  - 对应设计：`design.md` §2.3.3、§4.2、§6.1

### 阶段检查

- [ ] 2.4 远程连接主链路检查
  - 状态：TODO
  - 这一步到底做什么：验证从登录到远程 DSH RPC、文件流、断线恢复的完整主链路。
  - 做完你能看到什么：一台 Client 能稳定访问一台 CodingNS Host 上的 DSH。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本阶段全部 Transport 文件
  - 这一步先不做什么：不增加 CLI、终端和反向代理的新范围。
  - 怎么算完成：主链路和主要异常路径都有验证证据。
  - 怎么验证：真实 Control API、Relay、Host 和 Client 联调

## 阶段 3：接入功能模块并完成独立启停

- [ ] 3.1 接入工作区文件树和预览
  - 状态：TODO
  - 这一步到底做什么：把 CodingNS 工作区读取能力挂到 DSH Remote，并提供 Client 文件树和预览入口。
  - 做完你能看到什么：可以浏览目录、打开文本和图片预览，越界路径会被拒绝。
  - 先依赖什么：2.4
  - 开始前先看：`requirements.md` 需求 6
  - 主要改哪里：`src/features/workspace-files/`、Client Slot 目录
  - 这一步先不做什么：不实现完整 IDE 编辑器和移动端文件 UI。
  - 怎么算完成：路径限制、大小限制、排序和断线刷新都有测试。
  - 怎么验证：文件树和预览集成测试

- [ ] 3.2 接入 DSH Sidebar 的持久终端与后台任务
  - 状态：TODO
  - 这一步到底做什么：由插件自身实现 DSH `webTerminals` 兼容 controller、终端强化设置、持久映射、POSIX tmux、Windows ConPTY broker、生命周期协调和平台 shell 检测；后台任务使用独立 `task` 频道。
  - 做完你能看到什么：可以在插件挂载到 DSH Sidebar 的终端 UI 创建持久终端、输入命令、调整尺寸、显式关闭，并在浏览器、插件或 DSH 重启后重新 attach 到同一运行时；设置页可以控制下次启动是否启用强化，并选择默认终端与外观。
  - 先依赖什么：2.4
  - 开始前先看：`requirements.md` 需求 6；`../spec002-基于CodingNS隧道的DSH多路复用网关/design.md` §10；同 Spec 的 `tasks.md` 3.2.1～3.2.6。
  - 主要改哪里：以 Spec 002 的 3.2.1～3.2.6 和独立后台任务任务为准，本任务不再维护第二份实现清单。
  - 当前约束：DSH Web 是唯一主体；插件不得调用 CodingNS 父仓库或 Host 私有接口。浏览器不得直连本机 broker。官方 Host controller 与官方 terminal UI 成对禁用，插件在同一 Bundle generation 内原子提供 Typert、Host controller、`webTerminals` 与 Sidebar UI。
  - 这一步先不做什么：不承诺跨操作系统重启，不创建新的全局 inflight、timer 或重试队列，不创建脱离 DSH Web 的独立终端应用。
  - 怎么算完成：Spec 002 的 3.2.1～3.2.6 全部为 `DONE`，后台任务频道也完成独立验收；终端显式关闭、任务取消、崩溃恢复和资源回收均有证据。
  - 怎么验证：以 Spec 002 各子任务记录的定向测试、启停待重启测试、默认 profile 与样式作用域测试、三平台 DSH 重启验证和 Sidebar UI 回放为准。

- [ ] 3.3 接入外部 Agent Provider
  - 状态：IN_REVIEW（标准层、八个协议驱动、持久化外部会话和 DSH 原生会话接入已完成；真实 CLI/远程端到端执行仍待复核）
  - 这一步到底做什么：将 CodingNS 现有外部 Agent 统一成 DSH 可调用的 Provider，并允许每个 Agent 单独开关。
  - 做完你能看到什么：不同外部 Agent 可以在同一工作区启动、输入、查看输出和取消。
  - 先依赖什么：3.2
  - 开始前先看：`requirements.md` 需求 5
  - 主要改哪里：`src/host/cli-adapters/`、`src/client/features/cli-adapters.ts`、Provider registry
  - 本轮已完成：外部 Agent 统一使用 `CodingNsAgentEvent`，旧的流事件类型、工具观察类型、`tool-running` 事件名和浏览器权限回复 RPC 已删除；新增标准协议字段、能力声明、外部会话绑定和 Host-only raw store 引用。流式 JSON 驱动（Claude Code、Kimi、Gemini）、JSON-RPC/ACP 驱动（Pi、Codex、Grok）和 HTTP/SSE 驱动（OpenCode）全部通过统一注册表、设置页、会话选择器和 `llm/stream` 转换链路接入。八个驱动只输出公共事件，Registry 只管理执行、会话绑定和持久化状态；正文、思考、工具、权限申请、结构化问题、用量和终态都由唯一的 `CodingNsDshMessageProjector` 转换成 DSH 行为，只有该投影器与 `CodingNsNativeSessionBridge` 理解 DSH 原生契约。正文和思考支持 delta/snapshot，快照只输出新增后缀，usage 只保留最新值。Host 持久化 SessionStore、外部会话列表、原生 DSH SessionStore/SessionController/WorkspaceController 探测桥接已实现；消息由 DSH Agent Loop 写入原生会话时间线，Client 只提供恢复入口。已执行工具由公共层保存为 DSH `tool/call` 与 `tool/result` 历史，不进入模型流，不会被 Agent Loop 二次执行。`edit_file`、`write_file`、shell 和 read 类别名只在公共层映射，文件编辑结果携带 diff 元数据。Provider 原始会话会只读探测；确认删除后阻止 resume，并可通过 DSH 原生归档从侧栏移除。回归测试覆盖附件中的 Command Code 累积快照、fake 进程、SSE、会话恢复、脱敏、取消清理、权限与问题回传、工具历史边界、探测超时和执行/归档竞态；未知或未安装 Provider 仍返回不可用，不会阻塞其他模块。
  - 这一步先不做什么：不修改各外部 Agent 工具本身，不把 Provider 私有逻辑写进 Transport。
  - 怎么算完成：至少一个 Provider 端到端跑通，Provider 不可用时不会拖垮其他模块。
  - 怎么验证：在只包含本任务提交的隔离工作树中，`pnpm exec tsc --noEmit` 和 `pnpm build` 通过，显式执行 `node --test tests/*.spec.ts` 时 176/176 通过；`git diff --check` 通过。源码级回归会拒绝旧流事件类型、旧工具观察类型、`tool-running`、旧权限回复 RPC，以及驱动直接依赖 DSH 投影或原生会话桥接。另有 `tests/cli-session-security.spec.ts`、`tests/cli-session-probe.spec.ts`、`tests/client-cli-sessions.spec.ts` 覆盖脱敏、原始会话探测和恢复入口。对话框中的外部 Agent 模型/思考等级菜单使用 DSH 原生 Slot、设计令牌和菜单交互语义兼容实现；DSH Agent 仍使用原生模型组件。所有外部 Agent 只产出统一事件，公共投影层再通过 `Session.append(tool/call + tool/result)` 生成 DSH 原生历史和编辑 diff 元数据；不输出模型流 `tool-call`，不会触发 Agent Loop 二次执行。原生侧栏行仍没有 badge Slot，因此只有这一处保持安全降级。真实模型执行、各 Provider 真实版本兼容、宿主磁盘 Session persistence 和远程 Host/Client 端到端仍待验证。

- [ ] 3.4 接入进程、端口和反向代理
  - 状态：TODO
  - 这一步到底做什么：把进程启动、端口查询和显式授权的反向代理接入 Host，并提供 Client 状态界面。
  - 做完你能看到什么：可以查看和管理授权进程及端口，反向代理默认关闭且只开放明确目标。
  - 先依赖什么：3.2
  - 开始前先看：`requirements.md` 需求 7、需求 8
  - 主要改哪里：`src/features/process-manager/`、`src/features/reverse-proxy/`
  - 这一步先不做什么：不提供任意 URL 代理、不绕过 Host 权限、不默认暴露公网端口。
  - 怎么算完成：未授权目标全部拒绝，模块禁用后监听器和子进程全部清理。
  - 怎么验证：权限测试、端口冲突测试、代理目标白名单测试

### 阶段检查

- [ ] 3.5 功能模块独立启停检查
  - 状态：TODO
  - 这一步到底做什么：组合所有已实现模块，逐一启用、禁用和卸载，确认互不影响。
  - 做完你能看到什么：关闭一个模块不会让登录、Transport 或其他模块失效，也没有残留进程和连接。
  - 先依赖什么：3.1、3.2、3.3、3.4
  - 开始前先看：`design.md` §2.3.4、§4.2、§6.2
  - 主要改哪里：`src/features/`、`src/core/feature-registry.*`
  - 这一步先不做什么：不追加新的功能模块。
  - 怎么算完成：所有模块的状态、依赖、draining 和清理行为可追踪。
  - 怎么验证：模块矩阵测试、资源泄漏检查、人工回放

## 阶段 4：接入 PeerHost 和跨 Host 资源作用域

- [ ] 4.1 接入 PeerHost 配置和握手检查
  - 状态：TODO
  - 这一步到底做什么：保存当前用户的 PeerHost 配置，并通过目标 Host 握手检查产品、版本、API 兼容标识和 fingerprint。
  - 做完你能看到什么：PeerHost 列表能明确显示未知、检查中、可用、不可达和版本不一致状态。
  - 先依赖什么：2.4
  - 开始前先看：
    - `requirements.md` 需求 9 / 验收 9.1、9.2、9.3
    - `design.md` §2.3.5「PeerHost 添加、检查和代理」
    - 主仓库 `specs/spec001.3.2-当前HOST代理访问其他HOST仓库/`
  - 主要改哪里：
    - `src/features/peer-host/peer-host-registry.*`
    - `src/features/peer-host/host-handshake.*`
  - 这一步先不做什么：不开放任意 URL 代理；直接 WebRTC 连接和当前 Host 代转回退路径留到后续 HostRouter 任务统一处理。
  - 怎么算完成：
    1. 地址规范化和重复检查稳定。
    2. 只有同产品、同版本/API 兼容且指纹有效的目标才能进入 `ready`。
  - 怎么验证：
    - PeerHost 配置和握手单元测试
    - 可达、不可达、版本不一致和指纹变化联调

- [ ] 4.2 接入 PeerHost 目标登录态
  - 状态：TODO
  - 这一步到底做什么：在当前 Host 保存并刷新目标 Host 会话，让目标凭据不离开当前 Host。
  - 做完你能看到什么：目标登录态单独显示和刷新，目标会话失效不会退出当前 Host。
  - 先依赖什么：4.1
  - 开始前先看：
    - `requirements.md` 需求 9 / 验收 9.3、9.7
    - `design.md` §3.2.5「PeerHostRecord」
    - 主仓库 `specs/spec001.3.2-当前HOST代理访问其他HOST仓库/requirements.md` 需求 4
  - 主要改哪里：
    - `src/features/peer-host/peer-host-session-store.*`
    - `src/features/peer-host/peer-host-auth.*`
  - 这一步先不做什么：不把目标 token 写入 Client 状态、URL、日志或模型上下文。
  - 怎么算完成：目标会话可以单独登录、刷新、退出和清理。
  - 怎么验证：目标会话隔离、过期刷新和当前 Host 不受影响测试

- [ ] 4.3 接入 PeerHost HTTP/WS 白名单代理
  - 状态：TODO
  - 这一步到底做什么：代理工作区、文件、Git、会话和终端的明确 HTTP/WS 主链路，并过滤方法、路径和消息类型。
  - 做完你能看到什么：Client 只传 `targetHostId` 和资源请求，当前 Host 完成目标认证和受控转发。
  - 先依赖什么：4.2
  - 开始前先看：
    - `requirements.md` 需求 9 / 验收 9.4、9.5
    - `design.md` §3.3.4、§3.3.5
    - 主仓库 `apps/host/src/modules/peer-host/host-api-proxy-service.ts`
    - 主仓库 `apps/host/src/modules/peer-host/host-ws-proxy-service.ts`
  - 主要改哪里：
    - `src/features/peer-host/peer-host-http-proxy.*`
    - `src/features/peer-host/peer-host-ws-proxy.*`
    - `src/features/peer-host/peer-host-proxy-whitelist.*`
  - 这一步先不做什么：不做任意 URL 转发，不代理控制站登录接口，不默认转发二进制 WebSocket 消息。
  - 怎么算完成：未保存目标、未检查目标、未登录目标、非白名单路径和非白名单消息全部被拒绝。
  - 怎么验证：HTTP/WS 白名单测试、目标不可达测试、上游 401 清理测试

- [ ] 4.4 接入跨 Host 资源作用域和切换清理
  - 状态：TODO
  - 这一步到底做什么：把工作区、文件、Git、会话和终端请求统一绑定到 `hostId + workspaceId`，切换时先关闭旧作用域连接。
  - 做完你能看到什么：同名或相同 `workspaceId` 的不同 Host 资源不会串，切回主 Host 后旧 PeerHost 实时流不会继续更新页面。
  - 先依赖什么：4.3
  - 开始前先看：
    - `requirements.md` 需求 9 / 验收 9.6
    - `design.md` §3.2.6、§4.1、§4.2、§6.5
    - 主仓库 `specs/spec001.3.3-HOST与PEERHOST资源作用域统一与切换收口/`
  - 主要改哪里：
    - `src/features/resource-scope/`
    - `src/client/peer-host-workspace/`
  - 这一步先不做什么：不把多个 Host 的资源合并成无作用域的全局连接；不在本任务中实现 Desktop/H5 的多 Host Context。
  - 怎么算完成：作用域切换会递增 generation，旧 scope 的请求和消息无法写入新 scope。
  - 怎么验证：主 Host/PeerHost 来回切换、旧 WS 关闭和 workspaceId 冲突测试

### 阶段检查

- [ ] 4.5 PeerHost 主链路检查
  - 状态：TODO
  - 这一步到底做什么：验证从添加 PeerHost、握手、登录到文件、Git、会话和终端代理的完整链路。
  - 做完你能看到什么：一个 DSH Client 通过当前 Host 安全操作一台已授权 PeerHost，且能清楚看到目标状态。
  - 先依赖什么：4.1、4.2、4.3、4.4
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本阶段全部 PeerHost 和资源作用域文件
  - 这一步先不做什么：不追加跨 Host 数据同步、仓库迁移或全量 API 代理。
  - 怎么算完成：主流程、拒绝流程、断线流程和切换清理都有证据。
  - 怎么验证：双 Host 集成测试、WebSocket 实时流回放、权限和版本兼容测试

## 阶段 5：接入 HostScope、远程 Web Runtime 和客户端入口

- [ ] 5.1 实现 HostScope 与 HostRouter
  - 状态：TODO
  - 这一步到底做什么：为本地 Host、Remote Host A/B 建立独立连接、generation、资源作用域和路由，并在 Shell 层聚合会话列表。
  - 做完你能看到什么：同名工作区或会话不会串 Host；列表每项带 `hostId`、`hostLabel`、`workspaceId`、`sessionId` 和连接状态。
  - 先依赖什么：2.4、4.5
  - 主要改哪里：`src/client/host-router/`、`src/client/resource-scope/`、`src/shared/contracts.ts`
  - 这一步先不做什么：不把远程插件安装到本地 Profile，不修改 DSH 官方全局 Connection。
  - 怎么算完成：旧 generation 和旧 scope 的异步消息无法写入新 HostScope；聚合列表可按 Host 路由打开。
  - 怎么验证：多 Host Fake Transport 测试、Host 切换和同名资源隔离测试。

- [ ] 5.2 实现远程 DSH Web Runtime
  - 状态：IN_REVIEW（Host provider、web.* Gateway、浏览器隔离 Context 已有 Fake 测试；真实 DSH Web 服务尚未联调）
  - 这一步到底做什么：通过 `web.session.open`、`web.boot.get`、`web.asset.get` 和 WebSocket 流，把远程 Host 的官方 DSH Web 直接呈现给 H5/Desktop。
  - 做完你能看到什么：远程页面来自用户自己的 DSH Host，不需要在 Vercel/CDN 部署固定版本 DSH 前端。
  - 先依赖什么：5.1、2.3
  - 主要改哪里：`src/features/remote-web-runtime/`、`src/transport/`、`tests/remote-web-runtime.spec.ts`
  - 这一步先不做什么：不重写 DSH Web，不让控制站代理业务 HTTP/WebSocket。
  - 怎么算完成：boot、资源、WebSocket、关闭和 generation 替换都有 HostScope 校验和清理。
  - 怎么验证：`pnpm test -- tests/remote-web-runtime.spec.ts tests/dsh-session-gateway.spec.ts`；结果：远程 Session、boot、二进制 asset、Session close 和 WebSocket 错误收敛通过。真实 DSH Web 服务回放待完成。

- [ ] 5.3 实现按 HostScope 临时加载远程插件 Bundle
  - 状态：TODO
  - 这一步到底做什么：读取远程 Host 的 Plugin Manifest，按需下载 Client Bundle，并只在对应 Remote DSH Web Context 的临时 Loader 中执行。
  - 做完你能看到什么：远程插件界面可以使用；本地 Profile、全局 Loader 和其他 Host 不受影响。
  - 先依赖什么：5.2
  - 主要改哪里：`src/features/remote-web-runtime/plugin-loader.*`、`src/client/host-context.*`、`tests/remote-plugin-loader.spec.ts`
  - 这一步先不做什么：不把远程插件写入本地磁盘或本地 DSH 插件注册表。
  - 怎么算完成：Manifest/Bundle 版本、来源、HostScope 和 generation 校验失败时拒绝加载；Context 关闭后无残留 Loader。
  - 怎么验证：双 Host 同名不同版本插件测试、关闭 Context 清理测试。

- [ ] 5.4 接入 H5 Bootstrap
  - 状态：IN_REVIEW（静态 H5 runtime 已生成并接入；浏览器自动化和真实 Relay 仍待完成）
  - 这一步到底做什么：提供只负责浏览器会话、一次性访问码、ticket 和 Transport 启动的最小入口。
  - 做完你能看到什么：网页访问直接进入用户 Host 的 DSH Web，浏览器持久化状态没有 refresh token。
  - 先依赖什么：5.2
  - 主要改哪里：`src/client/h5-bootstrap/`、控制站集成契约、H5 测试
  - 这一步先不做什么：不部署独立固定版本 DSH 前端，不把业务请求转给控制站。
  - 怎么算完成：未登录、ticket 过期、WebRTC 失败和退出登录都有清理行为。
  - 怎么验证：`pnpm run build` 生成同级项目 `../dsh-codingns-h5/runtime.js`；`tests/dsh-h5-bootstrap.spec.ts` 通过。浏览器自动化、真实控制站/Relay 明文审计待完成。

- [ ] 5.5 接入官方 Desktop Client 模式
  - 状态：TODO
  - 这一步到底做什么：在官方 DSH Desktop 中注入 `dsh-codingns` Client Transport，并让远程 Host 以 PeerHost 会话出现在连接和会话列表中。
  - 做完你能看到什么：不自行打包 Win/macOS，也能从 Desktop 完整使用远程 Host 的 DSH 环境。
  - 先依赖什么：5.1、5.2、5.3
  - 主要改哪里：Desktop Client adapter、`src/client/host-context/`、Desktop 联调测试
  - 这一步先不做什么：不把远程插件安装到本地，不建立绕过 HostScope 的全局 Loader。
  - 怎么算完成：本地 Context 和每个远程 Context 独立；切换 Host 后旧 WebSocket、Bundle 和 generation 全部失效。
  - 怎么验证：官方 Desktop 手工回放、双远程 Host 聚合列表和插件兼容测试。

### 阶段检查

- [ ] 5.6 H5/Desktop/PeerHost 最终链路检查
  - 状态：TODO
  - 这一步到底做什么：验证网页、官方 Desktop、直接 WebRTC、PeerHost 受信任回退、远程插件和多 Host 会话聚合的组合行为。
  - 做完你能看到什么：一份明确记录，证明控制站/Relay 只看控制面，业务明文只在端到端两端出现。
  - 先依赖什么：5.1、5.2、5.3、5.4、5.5
  - 主要改哪里：`tests/e2e/`、联调记录、本文档验收状态
  - 这一步先不做什么：不在验收阶段新增协议频道或控制站业务能力。
  - 怎么算完成：直连、TURN、回退、断线、退出、Host 切换和其他插件加载均有验证证据。
  - 怎么验证：最小必要定向测试、浏览器/桌面回放、抓包和日志脱敏检查。

## 用户定义阶段 1 至 4 回写

用户将阶段重新定义为：阶段 1 模块注册和生命周期，阶段 2 登录/设备/Host 绑定，阶段 3 资源作用域模型，阶段 4 WebRTC 到 DSH Transport。对应实现和验收记录见 `docs/20260921-阶段1至4并行开发记录.md`。

- [x] 用户阶段 1：模块注册和生命周期（DONE）
  - 验证：`pnpm test -- tests/feature-registry.spec.ts`；8 个子测试通过。
- [x] 用户阶段 2：登录、设备、Host 绑定（DONE）
  - 验证：`pnpm test -- tests/auth.spec.ts`；6 个子测试通过；Control API 使用 `/api/v1/relay/signaling/ticket`，旧 `connect-init` 已确认是 410，不再使用。
  - Web 入口：`src/client/index.ts` 已接入登录、设备刷新、Host 绑定/解绑和退出登录表单；Host 通过 `/codingns` RPC 执行认证，浏览器不接触 refresh token。定向 Client/Host/契约测试 9/9 通过。
- [x] 用户阶段 3：资源作用域模型（DONE）
  - 验证：`pnpm test -- tests/resource-scope.spec.ts`；7 个子测试通过。
- [x] 用户阶段 4：WebRTC 到 DSH Transport（IN_REVIEW）
  - 验证：`pnpm test -- tests/transport.spec.ts tests/webrtc-client.spec.ts tests/webrtc-host.spec.ts`；10 个子测试通过。
  - 补充验证：全量阶段定向测试 52/52 通过；`pnpm exec tsc --noEmit` 通过；`npm pack --dry-run --json` 成功；本机 DSH `0.1.6-alpha.2` 临时 Profile `--dump-config` 能识别 `dsh-codingns`。
  - generation 边界：DSH API Gateway 已独占 `ConnectionGenerationSource` 和 `connection.start()`；普通 Client entry 不重复注册或启动 generation loop。`bindDshConnection*` 仅供显式 adapter 测试/独立运行时。
  - 残余风险：已增加 Host acceptor、generation adapter 和可注入背压契约，但真实 Relay/Control API、werift Host runtime、DSH/Host/Browser 端到端链路、Host carrier replacement、内部 channel envelope 和生产级窗口调度仍待联调。

统一验证：`pnpm exec tsc --noEmit`；阶段定向测试共 52/52 通过。

## 最终检查

- [ ] 4.6 阶段二最终验收
  - 状态：TODO
  - 这一步到底做什么：确认需求、设计、任务和验证证据一一对应，形成可交付的阶段二结果。
  - 做完你能看到什么：一个版本化的 `dsh-codingns` 插件发行包，以及完整的登录、连接、功能和安全验收记录。
  - 先依赖什么：2.4、3.5、4.5
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`、`docs/`
  - 主要改哪里：当前 Spec 全部文件、验收文档和发布清单
  - 这一步先不做什么：不把移动端原生壳并入阶段二，不追加未评审的控制站后端能力。
  - 怎么算完成：
    1. 需求 1～9 都有测试或人工验收证据。
    2. 风险、延期项、兼容矩阵和已知限制已经写清楚。
    3. 模块禁用后无残留服务、进程、监听器和 WebRTC 流。
  - 怎么验证：
    - 按 Spec 验收清单逐项核对
    - 运行本轮最小必要测试和 Host/Client 联调
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

说明：阶段 4.6 只验收原阶段 1～4 的 Host、认证、Transport、功能模块和 PeerHost 基线；HostRouter、远程 DSH Web Runtime、远程插件临时加载、H5 Bootstrap 和官方 Desktop Client 由阶段 5.1～5.6 单独验收。

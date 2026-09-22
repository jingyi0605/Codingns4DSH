# 任务清单 - 基于 CodingNS HTTP/WS 隧道的 DSH 多路复用网关（人话版）

状态：Draft；协议、Carrier、Multiplexer、业务模块、H5/Desktop 和多 Host 任务均未通过最终验收。

## 这份文档是干什么的

这份清单把统一数据面拆成可以逐步验证的工作。每个任务都说明要改什么、明确不做什么，以及如何证明完成。只有验证通过后才能标记为 `DONE`。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清原因
- `IN_REVIEW`：已有结果，等待复核
- `DONE`：已完成且已回写验证证据
- `CANCELLED`：取消，并写清原因

## 阶段 0：锁定协议和现有边界

- [ ] 0.1 对齐 spec001 与 spec002 的 Transport 边界
  - 状态：TODO
  - 这一步到底做什么：确认 spec001 的插件总体设计继续有效，并把数据面实现统一到“单 WebSocket、多逻辑流、DSH Envelope”。
  - 做完你能看到什么：接手的人不会在“原生 DSH Transport”与“HTTP/WS 多路复用网关”之间选错方案。
  - 先依赖什么：无
  - 开始前先看：`../spec001-DeepSeekHarness-CodingNS单一插件/requirements.md`、`../spec001-DeepSeekHarness-CodingNS单一插件/design.md`、本 Spec 的 `requirements.md` 和 `design.md`
  - 主要改哪里：本 Spec 文档；必要时同步 spec001 的 Transport 说明
  - 这一步先不做什么：不改 DSH 核心，不建立真实 WebRTC 连接。
  - 怎么算完成：
    1. 明确控制面、Carrier、DSH Envelope 和 Feature Module 的边界。
    2. 记录旧 Transport 骨架哪些可以复用、哪些只能作为占位。
  - 怎么验证：人工逐段走查；执行 `git diff --check`。
  - 对应需求：需求 1、需求 2、需求 3
  - 对应设计：§1、§2.1、§2.2

- [ ] 0.2 固化 DSH Envelope 和频道契约
  - 状态：TODO
  - 这一步到底做什么：把 Envelope 字段、消息大小、序号、频道和错误码写成共享 TypeScript 契约。
  - 做完你能看到什么：Host、Client 和测试使用同一套类型，不再由每个模块自行拼 JSON。
  - 先依赖什么：0.1
  - 开始前先看：`docs/20260921-DSH多路复用协议草案.md`、`design.md` §3.2、§3.3
  - 主要改哪里：`src/shared/`、`src/transport/`、`tests/contracts.spec.ts`
  - 这一步先不做什么：不实现模块业务，不接入真实 CLI 或 PTY。
  - 怎么算完成：
    1. 非法版本、未知频道、序号回退和超大 meta 都有明确错误。
    2. 二进制 body 不经过 Base64 转换。
  - 怎么验证：`pnpm test -- tests/contracts.spec.ts tests/transport.spec.ts`、`pnpm exec tsc --noEmit`。
  - 对应需求：需求 2、非功能需求 3
  - 对应设计：§3.2、§5、§6

### 阶段检查

- [ ] 0.3 协议基线检查
  - 状态：TODO
  - 这一步到底做什么：只检查协议和边界是否稳定，不扩展功能范围。
  - 做完你能看到什么：可以开始实现 Carrier 和 Gateway，而不会边写边改消息格式。
  - 先依赖什么：0.1、0.2
  - 开始前先看：`requirements.md`、`design.md`、`docs/20260921-DSH多路复用协议草案.md`、`tasks.md`
  - 主要改哪里：本阶段全部文档和共享契约
  - 这一步先不做什么：不补“顺便做”的 UI、移动端或控制站功能。
  - 怎么算完成：
    1. 每个需求都有对应设计章节和后续任务。
    2. 版本、能力、错误和资源清理规则没有互相冲突。
  - 怎么验证：需求-设计-任务追踪表人工核对；`git diff --check`。
  - 对应需求：全部需求
  - 对应设计：§1～§8

## 阶段 1：建立 Carrier 和 DSH Gateway

- [ ] 1.1 封装 CodingNS WebSocket Carrier
  - 状态：TODO
  - 这一步到底做什么：把现有 CodingNS `ws.open`、`ws.message`、分片和 `ws.closed` 封装成 DSH 可注入的 Carrier 接口。
  - 做完你能看到什么：上层只处理二进制消息和关闭原因，不需要知道 WebRTC 或 CodingNS TunnelFrame 细节。
  - 先依赖什么：0.3
  - 开始前先看：`design.md` §2.1、§3.1；`src/transport/carrier.ts`；`src/transport/webrtc-client.ts`
  - 主要改哪里：`src/transport/carrier.ts`、`src/transport/`、`tests/transport.spec.ts`
  - 这一步先不做什么：不实现 DSH RPC 和功能模块。
  - 怎么算完成：
    1. Carrier 能注入 Fake WebSocket 并正确处理分片、关闭和错误。
    2. 单个消息超过限制时不会在内存中无限拼接。
  - 怎么验证：Fake Carrier 单元测试；`pnpm test -- tests/transport.spec.ts tests/webrtc-client.spec.ts`。
  - 对应需求：需求 1、需求 2
  - 对应设计：§2.2、§3.1、§5

- [ ] 1.2 实现 DSH Session handshake
  - 状态：TODO
  - 这一步到底做什么：实现 `session.hello`、`session.ready`、心跳、能力协商和协议拒绝。
  - 做完你能看到什么：版本或能力不匹配时连接在业务流开始前失败，并有可读错误。
  - 先依赖什么：1.1
  - 开始前先看：`design.md` §2.3.1、§3.2.2、§4.2、§5.1
  - 主要改哪里：`src/transport/dsh-session.ts`、`src/shared/contracts.ts`、`tests/session.spec.ts`
  - 这一步先不做什么：不创建 RPC、PTY、文件等业务流。
  - 怎么算完成：
    1. 首条消息不是 hello、版本不兼容或能力越权时都会拒绝。
    2. 未进入 ready 前的业务消息全部被阻止。
  - 怎么验证：`pnpm test -- tests/session.spec.ts tests/contracts.spec.ts`。
  - 对应需求：需求 1、需求 3
  - 对应设计：§2.3.1、§3.2.2、§4.2

- [ ] 1.3 实现 Gateway 入口和流路由
  - 状态：TODO
  - 这一步到底做什么：建立 `__dsh__/transport/v1` 入口，将 Envelope 交给 Session、Multiplexer 和 FeatureRegistry。
  - 做完你能看到什么：可以打开一个空的 `rpc` 流并收到 accepted/rejected，不涉及真实业务执行。
  - 先依赖什么：1.2
  - 开始前先看：`design.md` §2.2、§3.3.1、§3.3.2
  - 主要改哪里：`src/transport/dsh-gateway.ts`、`src/features/registry.ts`、`tests/gateway.spec.ts`
  - 这一步先不做什么：不允许任意 URL 转发，不实现 PeerHost。
  - 怎么算完成：
    1. 未注册频道、已关闭 streamId 和非法状态都被拒绝。
    2. 一个流的错误不会广播到其他流。
  - 怎么验证：Gateway 集成测试；`pnpm test -- tests/gateway.spec.ts tests/feature-registry.spec.ts`。
  - 对应需求：需求 1、需求 2、需求 9
  - 对应设计：§2.2、§3.3.1、§3.3.2、§6.2

### 阶段检查

- [ ] 1.4 Carrier 到 Gateway 主链路检查
  - 状态：TODO
  - 这一步到底做什么：验证从 Fake CodingNS WebSocket 到 DSH Gateway 的完整握手和空流生命周期。
  - 做完你能看到什么：有一条可重复的测试证明控制站/Relay 不需要理解 DSH Envelope。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：`requirements.md` 需求 1～3；`design.md` §2.1、§2.3
  - 主要改哪里：本阶段全部 Transport 文件和测试
  - 这一步先不做什么：不接入真实外部控制站，不新增业务模块。
  - 怎么算完成：握手、关闭、非法消息和多流空载场景都有测试证据。
  - 怎么验证：`pnpm test -- tests/transport.spec.ts tests/session.spec.ts tests/gateway.spec.ts`、`pnpm exec tsc --noEmit`。
  - 对应需求：需求 1、需求 2、需求 3
  - 对应设计：§2.1、§2.3、§7.2

## 阶段 2：实现 Multiplexer、流控和 DSH RPC

- [ ] 2.1 实现 StreamMultiplexer 和 FlowController
  - 状态：TODO
  - 这一步到底做什么：实现多流并发、顺序、取消、窗口和队列上限。
  - 做完你能看到什么：慢文件流不会阻塞 RPC 或 PTY，窗口耗尽时上游读取会暂停。
  - 先依赖什么：1.4
  - 开始前先看：`design.md` §2.3.3、§3.1、§6.1
  - 主要改哪里：`src/transport/multiplexer.ts`、`src/transport/flow-controller.ts`、`tests/multiplexer.spec.ts`
  - 这一步先不做什么：不实现业务方法，不创建私有重连队列。
  - 怎么算完成：
    1. 流内序号、取消和关闭严格生效。
    2. 单流、会话和模块三级窗口都能限制内存。
  - 怎么验证：乱序、窗口耗尽、取消和大消息测试；`pnpm test -- tests/multiplexer.spec.ts`。
  - 对应需求：需求 2、需求 4、非功能需求 1
  - 对应设计：§2.3.3、§3.2.1、§6.1

- [ ] 2.2 接入 DSH RPC、事件和文件流
  - 状态：TODO
  - 这一步到底做什么：把 DSH 的 unary RPC、Remote、事件、bundle 和文件读写接到统一流协议。
  - 做完你能看到什么：远端可以完成一次 RPC、订阅一个事件流并上传/下载一个分块文件。
  - 先依赖什么：2.1
  - 开始前先看：`spec001` 的 DSH Transport 约束；`design.md` §3.3.2、§3.3.3、§7.2
  - 主要改哪里：`src/transport/dsh-transport.ts`、`src/features/dsh-rpc/`、`tests/dsh-transport.spec.ts`
  - 这一步先不做什么：不接 CLI、PTY、PeerHost 和端口模块。
  - 怎么算完成：
    1. RPC 取消不会留下未结束的流或 Promise。
    2. 文件流使用二进制分块、窗口和结束标记。
  - 怎么验证：Fake DSH runtime 集成测试；`pnpm test -- tests/dsh-transport.spec.ts`。
  - 对应需求：需求 4
  - 对应设计：§3.2.1、§3.3.2、§3.3.3、§5

- [ ] 2.3 实现 generation recovery 接口
  - 状态：TODO
  - 这一步到底做什么：将 Carrier 断开、ticket 重新申请、新 generation 和可恢复流 attach 接到 DSH Connection recovery。
  - 做完你能看到什么：重连后旧响应不会污染新会话，能恢复的流可重新 attach。
  - 先依赖什么：2.1、2.2
  - 开始前先看：`design.md` §2.3.4、§4.2、§6.1；后台任务接入规范（仅涉及任务恢复时）
  - 主要改哪里：`src/transport/recovery.ts`、`src/transport/dsh-transport.ts`、`tests/recovery.spec.ts`
  - 这一步先不做什么：不为每个模块实现私有 reconnect loop。
  - 怎么算完成：generation、ticket 过期、Host 重启和旧回调隔离都有测试。
  - 怎么验证：`pnpm test -- tests/recovery.spec.ts tests/dsh-transport.spec.ts`。
  - 对应需求：需求 1、需求 4、非功能需求 2
  - 对应设计：§2.3.4、§4.2、§6.1

### 阶段检查

- [ ] 2.4 DSH 主链路检查
  - 状态：TODO
  - 这一步到底做什么：验证一条会话同时跑 RPC、事件、文件和两个互不阻塞的逻辑流。
  - 做完你能看到什么：Transport 不再只是帧测试，而是能完成 DSH 最小远程工作流。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：`requirements.md` 需求 1～4；`design.md` §7
  - 主要改哪里：本阶段全部 Transport 和 DSH RPC 文件
  - 这一步先不做什么：不扩展新模块，不进行 UI 开发。
  - 怎么算完成：RPC、文件、取消、背压、断线恢复有一组可回放证据。
  - 怎么验证：`pnpm test -- tests/multiplexer.spec.ts tests/dsh-transport.spec.ts tests/recovery.spec.ts`、`pnpm exec tsc --noEmit`。
  - 对应需求：需求 1～4
  - 对应设计：§2.3、§6、§7

## 阶段 3：接入业务模块

- [ ] 3.1 接入 CLI 适配器
  - 状态：TODO
  - 这一步到底做什么：把 Codex、Command Code、Claude Code 等适配器统一成 `adapter` 频道，并支持单独启停。
  - 做完你能看到什么：至少一个真实适配器可以启动、收发 stdin/stdout/stderr、取消并返回 exit。
  - 先依赖什么：2.4
  - 开始前先看：`requirements.md` 需求 5；`design.md` §2.2；CodingNS 现有 CLI 适配器契约
  - 主要改哪里：`src/features/cli-adapters/`、`src/features/registry.ts`、`tests/cli-adapter.spec.ts`
  - 这一步先不做什么：不修改 CLI 工具本身，不把 Provider 私有协议写入 Transport。
  - 怎么算完成：不可用 Provider 只影响本流；退出和清理没有残留进程。
  - 怎么验证：Provider contract 测试和一个真实 CLI 冒烟测试。
  - 对应需求：需求 5、需求 9
  - 对应设计：§2.2、§3.1、§6.3

- [ ] 3.2 接入 Shell、PTY 和后台任务
  - 状态：TODO
  - 这一步到底做什么：把 tmux、PTY 和 CodingNS 后台任务服务映射到 `pty`、`task` 频道。
  - 做完你能看到什么：可以输入命令、调整窗口、查看实时输出、取消任务，并在允许时重新 attach。
  - 先依赖什么：2.4
  - 开始前先看：`requirements.md` 需求 6；`design.md` §2.3.3、§4.2；后台任务接入规范
  - 主要改哪里：`src/features/terminal/`、`src/features/tasks/`、`tests/terminal.spec.ts`、`tests/tasks.spec.ts`
  - 这一步先不做什么：不创建私有 timer、inflight 或重试队列，不绕开现有 TaskManager。
  - 怎么算完成：PTY、任务、断线、取消和资源清理都有证据。
  - 怎么验证：Fake PTY/TaskManager 集成测试；按后台任务规范执行最小验证。
  - 对应需求：需求 6、需求 9、非功能需求 2
  - 对应设计：§2.2、§2.3.3、§4.2、§6.3

- [ ] 3.3 接入进程、端口和反向代理
  - 状态：TODO
  - 这一步到底做什么：提供授权范围内的进程启动、端口状态和显式目标反向代理。
  - 做完你能看到什么：可以查看和管理目标进程及端口，未登记目标全部拒绝。
  - 先依赖什么：3.2
  - 开始前先看：`requirements.md` 需求 7；`design.md` §2.2、§3.3.2
  - 主要改哪里：`src/features/process-network/`、`tests/process-network.spec.ts`
  - 这一步先不做什么：不提供任意 URL 代理，不默认暴露公网端口。
  - 怎么算完成：端口冲突、目标白名单、模块停用和监听器回收都有测试。
  - 怎么验证：权限和端口集成测试。
  - 对应需求：需求 7、需求 9
  - 对应设计：§2.2、§3.3.2、§6.3

- [ ] 3.4 接入 PeerHost 代理
  - 状态：TODO
  - 这一步到底做什么：把 CodingNS 现有 PeerHost 登记、在线检查、登录态和白名单规则接到 `peerhost` 频道。
  - 做完你能看到什么：当前 Host 可以受控访问一个已登记 PeerHost，Client 不会拿到目标 token。
  - 先依赖什么：2.4、3.3
  - 开始前先看：`requirements.md` 需求 8；`design.md` §3.3.4、§6.4；CodingNS PeerHost 相关 Spec
  - 主要改哪里：`src/features/peerhost/`、`src/shared/`、`tests/peerhost.spec.ts`
  - 这一步先不做什么：不把 PeerHost 变成任意 URL 代理；直接 WebRTC 连接和当前 Host 代转回退的选择由后续 HostScope 任务统一实现。
  - 怎么算完成：目标失效、登录态过期、白名单拒绝和资源作用域切换都有测试。
  - 怎么验证：Fake PeerHost registry + Host/Client 集成测试。
  - 对应需求：需求 8、需求 9
  - 对应设计：§2.2、§3.3.4、§6.4

### 阶段检查

- [ ] 3.5 功能模块独立启停检查
  - 状态：TODO
  - 这一步到底做什么：逐个启用、停用和重启所有已实现模块，确认模块之间没有隐式依赖和资源泄漏。
  - 做完你能看到什么：关闭 CLI 不影响 PTY，关闭 PeerHost 不影响 RPC，关闭全部模块仍能安全关闭 Session。
  - 先依赖什么：3.1、3.2、3.3、3.4
  - 开始前先看：`design.md` §2.2、§6.3；`requirements.md` 需求 9
  - 主要改哪里：`src/features/`、`tests/feature-lifecycle.spec.ts`
  - 这一步先不做什么：不添加新的业务频道。
  - 怎么算完成：每个模块均有启停、错误隔离和资源清理证据。
  - 怎么验证：`pnpm test -- tests/feature-registry.spec.ts tests/feature-lifecycle.spec.ts`。
  - 对应需求：需求 5～9
  - 对应设计：§2.2、§6.2、§6.3

## 阶段 4：真实联调和安全验收

- [ ] 4.1 接入真实 Control API、Relay 和 Host
  - 状态：TODO
  - 这一步到底做什么：使用真实 signaling ticket、Relay Signaling、Host fingerprint 和 WebRTC DataChannel 复核 Carrier 到 Gateway 的主链路。
  - 做完你能看到什么：真实环境下可以从 Client 登录并打开 DSH Gateway，不再只依赖 Fake。
  - 先依赖什么：3.5
  - 开始前先看：`apps/codingns-proxy` 当前 ticket 和 signaling 契约；`design.md` §2.3.1
  - 主要改哪里：联调脚本、`tests/e2e/`、必要的 Control API 契约适配
  - 这一步先不做什么：不让 Relay 解析业务消息，不修改旧 CodingNS 客户端行为。
  - 怎么算完成：直连和 TURN 路径均有成功与失败证据。
  - 怎么验证：真实 Control API/Relay/Host/Client 联调记录；不得把 token 写入日志。
  - 对应需求：需求 1、需求 3、非功能需求 2
  - 对应设计：§2.1、§2.3、§7.3

- [ ] 4.2 完成安全、兼容和压力验收
  - 状态：TODO
  - 这一步到底做什么：验证协议版本、权限、资源清理、慢流、并发流和异常依赖，确认不会破坏现有 CodingNS 隧道。
  - 做完你能看到什么：有一份可交付的验收记录，明确已通过项和剩余风险。
  - 先依赖什么：4.1
  - 开始前先看：`requirements.md` 全文；`design.md` §5、§6、§8；`docs/20260921-DSH多路复用协议草案.md`
  - 主要改哪里：测试、联调记录和本 Spec 状态
  - 这一步先不做什么：不在验收阶段临时增加新频道或新依赖。
  - 怎么算完成：
    1. 所有成功定义都有测试或人工记录。
    2. 未完成项写入风险和后续任务，不伪装成已完成。
  - 怎么验证：`pnpm test -- tests/contracts.spec.ts tests/transport.spec.ts tests/multiplexer.spec.ts tests/recovery.spec.ts`、`pnpm exec tsc --noEmit`，再执行真实联调清单。
  - 对应需求：全部需求和非功能需求
  - 对应设计：§7、§8

### 阶段 4 历史最终检查

- [ ] 4.3 Spec 验收和状态回写
  - 状态：TODO
  - 这一步到底做什么：将需求、设计、任务和验证证据逐项对上，决定 Spec 是否完成或需要拆分后续 Spec。
  - 做完你能看到什么：任何接手者都能知道已完成能力、未完成能力、验证命令和残余风险。
  - 先依赖什么：4.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`、`docs/`
  - 主要改哪里：本 Spec 全部文档，必要时同步 spec001 的状态说明
  - 这一步先不做什么：不新增需求，不把未验证的真实联调写成 DONE。
  - 怎么算完成：
    1. 所有 DONE 任务均有命令或人工验收证据。
    2. Draft/IN_REVIEW/BLOCKED 项均写清原因和下一步。
  - 怎么验证：Spec 追踪表人工核对；`git diff --check`。
  - 对应需求：全部需求
  - 对应设计：§1～§8

## 阶段 5：HostScope、远程 Web Runtime 和客户端接入

阶段 5 是在阶段 4 数据面验收之后追加的客户端接入工作。阶段 4 的历史任务状态保留，不代表阶段 5 已完成。

- [ ] 5.1 增加 HostScope 与 generation 路由
  - 状态：TODO
  - 这一步到底做什么：让每条 Envelope 携带 `hostScope` 和 `generation`，并拒绝旧 Host 或旧代次消息。
  - 做完你能看到什么：本地、remote-a、remote-b 的同名资源不会串线。
  - 先依赖什么：0.3、2.3
  - 主要改哪里：`src/shared/`、`src/transport/dsh-session.ts`、`src/transport/multiplexer.ts`
  - 这一步先不做什么：不实现 UI，不把资源 ID 改成全局裸 ID。
  - 怎么算完成：HostScope/generation 校验、错误码和旧回调隔离有测试。
  - 怎么验证：`pnpm test -- tests/contracts.spec.ts tests/session.spec.ts tests/multiplexer.spec.ts`。

- [ ] 5.2 实现 `web.*` 远程 DSH Web 流
  - 状态：TODO
  - 这一步到底做什么：在同一 Multiplex Gateway 中传输 DSH Web boot、静态资源和 WebSocket 数据。
  - 做完你能看到什么：H5/Desktop 可以显示远程 Host 自己的 DSH Web，不需要独立固定前端。
  - 先依赖什么：5.1、2.4
  - 主要改哪里：`src/features/remote-web/`、`src/transport/`、`tests/remote-web.spec.ts`
  - 这一步先不做什么：不让控制站终止业务 HTTP/WebSocket，不把资源放到 Relay。
  - 怎么算完成：`web.session.open`、`web.boot.get`、`web.asset.get`、`web.ws.*` 的生命周期、窗口和清理完整。
  - 怎么验证：Fake Web Runtime 集成测试和二进制 WebSocket 回放。

- [ ] 5.3 实现 `web.plugin.*` 临时 Bundle 流
  - 状态：TODO
  - 这一步到底做什么：传输远程 Host 的 Plugin Manifest/Bundle，并要求 Client 绑定对应 HostScope 的临时 Loader。
  - 做完你能看到什么：远程插件可用，但不会安装到本地 Profile 或污染其他 Host。
  - 先依赖什么：5.2
  - 主要改哪里：`src/features/remote-web/plugin-stream.*`、`tests/plugin-scope.spec.ts`
  - 这一步先不做什么：不实现全局插件合并，不允许跨 Host 复用 Bundle。
  - 怎么算完成：来源、版本、HostScope、generation 失败时拒绝；Context 关闭后无残留。
  - 怎么验证：双 Host 同名不同版本 Bundle 和清理测试。

- [ ] 5.4 接入 H5 Bootstrap 和官方 Desktop Client
  - 状态：TODO
  - 这一步到底做什么：验证 H5 最小 Bootstrap 与官方 DSH Desktop 的 Client Transport 都能打开同一个 Gateway。
  - 做完你能看到什么：网页和 Desktop 都直接使用远程 DSH Host；第一阶段不需要自行打包 Win/macOS。
  - 先依赖什么：5.2、5.3、spec001 的 HostRouter 任务
  - 主要改哪里：H5/desktop adapter、`tests/e2e/`、联调记录
  - 这一步先不做什么：不部署独立 DSH 前端，不把远程插件写入本地安装目录。
  - 怎么算完成：登录、ticket 过期、断线、Host 切换、退出和浏览器存储检查均通过。
  - 怎么验证：浏览器自动化、官方 Desktop 手工回放、日志/抓包明文审计。

### 阶段检查

- [ ] 5.5 多 Host 与 PeerHost 最终验收
  - 状态：TODO
  - 这一步到底做什么：验证直接 WebRTC、PeerHost 受信任回退、多 Host 会话聚合和远程插件隔离的组合行为。
  - 做完你能看到什么：一份证据证明业务明文只在端到端两端，旧 HostScope 不会更新新页面。
  - 先依赖什么：5.1、5.2、5.3、5.4
  - 主要改哪里：`tests/e2e/`、验收记录和协议草案
  - 这一步先不做什么：不在验收阶段新增频道或改变控制站职责。
  - 怎么算完成：直连、TURN、回退、恢复、插件加载和其他 DSH 插件兼容均有记录。
  - 怎么验证：最小定向测试、浏览器/桌面回放、抓包和控制站/Relay 日志检查。

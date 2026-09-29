# 集成到 Codex Desktop 与集成到 DSH 的技术差别

日期：2026-09-29
范围：对比"把外部 Agent 适配器接入 Codex Desktop（`codex-host` 的做法）"与"接入 DSH（本插件的做法）"两条路径的技术差别，用于判断同一批适配器在两侧的集成效果差异。本文件是 spec007.1 的补充分析。

## 一、结论摘要

两侧的差别**不在适配器写法上，而在"宿主给适配器留了什么位置"**。同样是"让外部 CLI 在当前对话里干活"，两边落点完全不同：

| 维度 | 集成到 Codex Desktop（codex-host） | 集成到 DSH（本插件） |
| --- | --- | --- |
| 接入方式 | 启动器 + CDP/Electron Inspector 扩展官方桌面应用；CLI Shim 透传官方 app-server | 官方插件契约（Cordis bundle + 官方 Slot + 自注册 RPC） |
| 身份 | 桌面应用不认识插件，适配器**复用**桌面应用的 UI 与协议层 | 宿主知道插件存在，插件是**一等公民** |
| 外部 Agent 的宿主身份 | 一等 Harness，与官方 Codex 并列可选 | 外部运行时，**不是** DSH Agent |
| 能否成为原生子 Agent | 不适用（宿主没有这个概念） | 不能直接成为，需经 `ctx.subagents` seam 适配 |
| 升级风险 | 较高：依赖 CDP 注入点、官方 app-server 形态与私有 ACP 扩展 | 较低：依赖公开契约，且有版本路由矩阵兜底 |
| 能力上限 | 高：外部 Harness 直接获得桌面原生 Edit Diff / Fork / 消息编辑 / slash 命令 | 受限于 DSH 公开插槽与事件模型 |

一句话：**codex-host 是在官方桌面应用前面"架一层启动器与协议 shim"，把外部 Harness 接进官方 UI；本插件是在自家宿主的插件体系里"内建"一个 Agent 选择器。** 前者能直接复用宿主成熟 UI，但耦合在宿主进程形态上；后者契约稳定、可降级、可诊断，但要自己实现更多 UI 与编排。

## 二、两侧的接入机制

### 2.1 codex-host → Codex Desktop

官方 README 的 "How it works" 段落给了最准确的描述：

> - **Desktop:** extends the official Codex Desktop via CDP / Electron Inspector — no rebuilt chat UI, no patched installer.
> - **Protocol:** a CLI Shim sits in front of the official app-server and passes native Codex requests through untouched.
> - **Harnesses:** each Harness is integrated through its own native interface where one exists (Pi over RPC, Claude Code via the Agent SDK), falling back to ACP otherwise. Streaming, tool status, diffs, approvals, and questions all render in Codex Desktop's native UI.
> - **Orchestration:** delegated tasks run as independent native sessions in the target Harness.

关键点有三个：

1. **不重写 UI、不打补丁安装包**：通过 CDP / Electron Inspector 扩展官方桌面应用。它是**启动器**——用户通过 `codexhost` 启动 Codex Desktop（README 的 Windows 便携版说明要求"完全退出 Codex Desktop，再运行 `codexhost`"），而不是改安装目录里的文件。
2. **CLI Shim 透传**：在官方 app-server 前面放一层 shim，原生 Codex 请求原样透传。这意味着官方 Codex 路径的行为不被改变。
3. **流式、工具状态、diff、审批、提问全部渲染在 Codex Desktop 原生 UI 里**——适配器只负责把外部 Agent 的事件投影成公共 Item。

### 2.1.1 注入机制的具体形态（已核实）

启动器是 Rust 实现（`crates/launcher`），它自己拉起 Codex Desktop 可执行文件，并附加 Chromium 调试参数：

- `crates/launcher/src/desktop_attachment.rs` 的 `allocate_runtime_control()` 先 `TcpListener::bind(("127.0.0.1", 0))` 拿一个随机端口再 drop，然后把 `--remote-debugging-address=127.0.0.1` 与 `--remote-debugging-port=<该端口>` 传给 Desktop。
- 注入 renderer：CDP 连到 `app://-/index.html` 主窗口（`packages/desktop-control/src/renderer-cdp-control-session.ts` 的 `isPrimaryRendererUrl` 精确匹配该 URL），用 `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate` 跑整个 renderer bundle。
- 同时注入主进程：`packages/desktop-control/src/production-controller.ts` 构造 `window.__codexhostProductionConfigV1`，另有 main-process title policy 通过 Electron `[[Scopes]]` + `Runtime.callFunctionOn` 包装标题生成服务。
- **app.asar 只被读取做 sha256 完整性登记**（`crates/platform/src/installation.rs`），没有解包或改写——所以"不打补丁"是真的。

**一个对本项目很重要的结构性事实**：注入层与适配器层是**解耦**的。适配器插件**不接触 CDP 或 DOM**；所有私有 API 依赖都集中在 codexhost 的 `desktop-control` / `renderer-extension` 公共层。架构文档把"不允许插件任意访问 Desktop 内部 DOM、React 状态、Electron 私有 API 或 RequestManager"列为非目标（§1.3）。这一点值得本项目借鉴：**私有依赖要收敛到边界层，不能散进每个驱动**。

**另一个现状（影响"新增适配器的边际成本"）**：Renderer 侧仍是静态名单，而且是**两层静态**：

第一层，`packages/desktop-control/src/production-controller.ts` 硬编码了 16 个 `enabledAgents`：

```ts
enabledAgents: [
  "codex", "pi", "claude-code", "deepseek-harness", "opencode", "grok",
  "omp", "antigravity", "kiro-cli", "codebuddy", "workbuddy",
  "cursor-cli", "hermes", "qoder", "qoder-cn", "kimi-code",
],
```

第二层，`packages/renderer-extension/src/agent-selection-state.ts` 有静态联合类型，且 `DraftComposerState` 为**每个 Harness 单独开字段**：

```ts
export const KNOWN_RENDERER_AGENTS = [ /* 同上 16 项 */ ] as const;
export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];

export interface DraftComposerState {
  agent: RendererAgent;
  piModel?: HarnessModelRef;
  claudeModel?: HarnessModelRef;
  grokModel?: HarnessModelRef;
  ompModel?: HarnessModelRef;
  antigravityModel?: HarnessModelRef;
  qoderModel?: HarnessModelRef;
  qoderCnModel?: HarnessModelRef;
  // …每个 Harness 一组 Model + ThinkingOptionId
}
```

文档也承认："当前接入可能需要扩展 Renderer 的固定联合类型及映射；列出实际修改位置和原因，而不是全仓库机械补名字。"

**这条对比很关键**：

| 接一个新 Agent 的边际成本 | Codex Desktop 侧 | DSH 侧（本插件） |
| --- | --- | --- |
| 驱动/协议 | 写适配器 | 写驱动 |
| UI 登记 | **改 Renderer 静态联合类型 + 每 Harness 字段 + 硬编码 enabledAgents，并重建 Renderer bundle** | 在 `provider-icons.ts` 等登记点加一条；UI 走官方 Slot |
| 构建产物 | 需重建 renderer bundle | 插件自身 bundle |

也就是说，**codex-host 加一个 Agent 比它自己宣称的"只交付插件、不重新构建 Renderer"要重**——那是它的目标而非现状。

**重要澄清（避免常见误解）**：`codex-host` **明确禁止**插件任意注入。其架构文档把"不允许插件任意访问 Desktop 内部 DOM、React 状态、Electron 私有 API 或 RequestManager"和"不提供无限制的 `invoke(method, any)` 或任意插件 HTML/JavaScript 注入"列为**非目标**。所以它是"受控的宿主协议扩展"，不是"往页面里塞脚本"。

适配器以 **Manifest + 工厂函数**交付：`manifest.json` 声明 `id`、`entry`、`icon`、`adapterApiVersion`，运行时由插件加载器载入 `createHarnessAdapter(context)`。

宿主侧分层：

| 包 | 职责 |
| --- | --- |
| `harness-adapter` | 公共契约（`HarnessAdapter` / `HarnessSession` / 类型与校验工具） |
| `host-runtime` | 线程映射、事件投影、会话生命周期 |
| `protocol-core` | 宿主与桌面应用之间的协议编解码 |
| `renderer-extension` | 注入 renderer 的 UI 扩展（Agent 选择器、设置页、图标） |
| `harness-broker` | macOS 受管远程场景下承载受信任会话 |

**必须知道的一个现状**：codex-host 的插件化**尚未完成**。其运行时文档明确列出未实现项，其中与本文最相关的是：

> Renderer Picker、图标、Composer 状态、偏好及 Sidebar 全部改由目标 Host 目录驱动。目前只提供经过校验、按连接发送的 Renderer 目录查询客户端，**新插件不会自动出现在现有 Picker 中**。

以及"删除 Renderer 等公共层的剩余 Harness 静态名单、旧路由和按名称区分的恢复策略"尚未完成。也就是说，codex-host 自己的插件体系也还处在"Host 侧已动态化、Renderer 侧仍静态"的中间状态。

### 2.2 本插件 → DSH

- 本插件是 **DSH 官方插件**，不是外挂进程。它在 `package.json` 的 `dsh` 字段声明：
  - `bundle.patch`：用声明式 patch 停用/插入 Bundle 行（例如停用官方 terminal 行、插入自己的插件行）。
  - `client.inject`：声明它需要注入哪些 DSH 官方客户端包（`dsh-client-ui-conversation`、`dsh-client-ui-tool` 等）。
- 运行时通过 **Cordis 插件系统**加载，拿到的是 DSH 的 `Context`（`ctx.subagents`、`ctx.agents`、`ctx.sessions`、`ctx.agentTeams` 等 seam）。
- UI 通过 **DSH 官方 Slot 契约**注册：本插件在 `conversation.input.right` 插槽注册 Agent 选择器与模型选择器（`src/client/cli-slots.ts`），而不是往 DOM 里塞自定义节点。
- Host 侧通过 `context.services.rpc.register('cli', ...)` 注册自己的 RPC 命名空间（`src/host/cli-adapters/feature.ts`）。

## 三、决定集成效果的关键差别

### 3.0 职责划分：宿主管什么、适配器管什么

这是理解两侧差别的基础。`codex-host` 的 `HarnessSession` 契约（`packages/harness-adapter/src/text-session.ts`）规定得很清楚：

```ts
export interface HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly commands?: HarnessCommandCapability;

  refreshUsage?(): Promise<void>;
  hasBackgroundWork?(): boolean;
  stopBackgroundWork?(): Promise<HarnessResult<void>>;
  readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>>;
  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(command: PermissionModeSelectCommand): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  close(): Promise<void>;
}
```

`open()` 支持四种模式，**全部由适配器实现**：`create`、`resume`、`fork`、`rollbackLastTurn`。这意味着 Fork 与回滚在 Codex Desktop 侧是**适配器的责任**，桌面应用只提供 UI 入口与 checkpoint 选择界面。

| 事项 | Codex Desktop 侧谁负责 | DSH 侧谁负责 |
| --- | --- | --- |
| 聊天 UI / 消息渲染 | 桌面应用原生 | DSH 原生（插件注册插槽） |
| Agent 选择器 UI | `renderer-extension`（**目前仍是静态名单**） | 插件注册 `conversation.input.right` 插槽 |
| 会话列表 | 桌面应用原生（外部 Thread 进入官方列表） | DSH 原生侧栏 + 插件会话存储 |
| Edit Diff 渲染 | 桌面应用原生 | 插件投影为 DSH 工具事件 |
| 线程 ↔ 原生会话映射 | `host-runtime` | 插件的 session store + DSH 原生会话桥 |
| 进程/协议驱动 | **适配器** | **插件驱动**（本插件的 `CodingNsCliDriver`） |
| 事件投影 | **适配器** | **插件**（投影为 `CodingNsAgentEvent`） |
| 模型目录 / Thinking | **适配器** | **插件** |
| 权限 / 提问 | **适配器**（宿主提供 UI 组件） | **插件**（DSH 提供 approval / questions 体系） |
| Usage | **适配器** | **插件** |
| Fork / 回滚 | **适配器**（桌面提供 UI 入口） | **插件**（DSH 有 fork 能力但外部 session 需自行处理） |
| slash 命令 | **适配器**声明 + 桌面渲染 | **插件**声明 + DSH 命令体系 |
| 会话导入 | **适配器**（`sessionImport` 契约） | 插件自有 |

**结论**：两侧都是"适配器/插件干重活"，差别在**宿主提供的复用面**。Codex Desktop 把 UI（消息、diff、审批、提问、Fork 入口、命令）全包了，适配器专注协议；DSH 把 UI 拆成插槽与事件体系，插件要自己组装更多东西，但换来的是**契约公开、可版本路由、可诊断**。

### 3.0.1 两侧契约的形状对照

Codex Desktop 侧的 `HarnessAdapter`（`packages/harness-adapter/src/text-session.ts`）只有三个核心方法：

```ts
export interface HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly commandCatalog?: HarnessCommandCatalog;
  readonly sessionImport?: HarnessSessionImportCapability;
  readonly subagents?: HarnessSubagentCapability;
  readonly webUi?: HarnessWebUiAction;
  inspectAccount?(): Promise<HarnessAccountSnapshot | null>;

  inspect(input?: InspectHarnessInput): Promise<HarnessInspection>;
  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}
```

本插件的对应契约（`src/host/cli-adapters/driver.ts`）形状更"扁"：

```ts
export interface CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  readonly supportsSegmentedTurns?: boolean
  detect(): Promise<Pick<CodingNsCliAdapterDescriptor, 'installed' | 'version' | 'command'>>
  listModels(): Promise<CodingNsCliModelCatalog>
  probeSession?(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult>
  executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent>
  respondPermission?(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> | void
  respondQuestion?(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> | void
  steer?(sessionId: string, prompt: string): Promise<void> | void
  followUp?(sessionId: string, prompt: string): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  dispose?(): Promise<void> | void
}
```

三点值得注意的差异：

1. **事件模型**：Codex Desktop 用 `AsyncIterable<HarnessOutput>` + `HostItemOutcome`（有 Item 生命周期、终态、不可变 start 等语义）；本插件用 `AsyncIterable<CodingNsAgentEvent>`，事件类型只有 7 种（session-binding / text-delta / reasoning-delta / tool-event / permission-request / usage / finish），更扁平。
2. **会话打开**：Codex Desktop 把 `create`/`resume`/`fork`/`rollbackLastTurn` 建模成 `OpenSessionInput` 的四种分支，由适配器实现；本插件的 `executeTurn` 只处理"这一轮"，会话绑定由注册表与 session store 管，Fork/回滚不在 driver 契约里。
3. **可选能力**：Codex Desktop 用 `subagents?`、`sessionImport?`、`webUi?` 等可选成员表达；本插件用 `descriptor.capabilities` 字符串数组表达，能力缺失时由注册表返回结构化诊断。

**对本项目的含义**：本插件的能力枚举（`CodingNsCliCapability`）比 Codex Desktop 的契约粗，所以"某适配器支持 Fork"这类信息在本插件里**无法用现有能力枚举表达**，只能进详情面板或文档。这也是 spec007 把 Fork/回滚放在 Team 层之外的原因。

### 3.1 外部 Agent 在宿主里的"身份"不同

这是最本质的差别。

**Codex Desktop 一侧**：`codex-host` 把每个外部 CLI 提升为与官方 Codex 并列的 **Harness**。用户在选择器里切换 Harness，就像切换模型一样；外部 Harness 拥有自己的 Thread，出现在官方会话列表里，可以用桌面原生的 Edit Diff、Fork、消息编辑和 slash 命令。**桌面应用愿意把 UI 能力开放给它。**

**DSH 一侧**：DSH 有明确的 Agent 模型——`ctx.agents` 是**进程内活跃 Agent 注册表**，`Agent` 对象由 `AgentRegistry.create()` 创建，绑定 `sessionId` 与 Session Log。外部 CLI 没有 `Agent` 句柄，因此**不能成为一个 DSH Agent**。

这一点在 DSH 的公开类型里有硬证据。`spawnTeammate` 的请求字段是：

```ts
export interface SpawnTeammateRequest {
    readonly name: string;
    readonly description: string;
    readonly prompt: ContentBlock[];
    readonly context: 'fresh' | 'fork';
    readonly provider: string;   // 注意：是"模型提供商"，不是"外部 Agent"
    readonly signal: AbortSignal;
}
```

其中 `provider` 指的是 DSH 的模型提供商路由（`@deepseek-ai/dsh-llm` 是"Provider-neutral LLM service interface"），**没有 adapter、model、effort、providerSessionId 这些字段**。这正是 spec007 判定"外部 Agent 不能直接成为 DSH 原生 Agent"的根源：宿主团队工具在设计上就没打算接纳非 DSH 执行器。

**后果**：在 DSH 里，外部 Agent 只能作为"插件自有的逻辑成员"存在，由插件自己的 Team 层编排，再由插件详情面板展示。官方 DSH Team 面板看不到它们。

### 3.2 原生 sub-agent 体系的可接入性不同

DSH 提供了 `codex-host` 完全没有的官方 seam：**`ctx.subagents`**。

它的定义（`@deepseek-ai/dsh-subagent`）是"named-provider registry for delegating to child agents"，公开操作包括 `start`（一次性子 Agent）、`startContinuable`（持久可续子 Agent）、`sendMessage`。更关键的是它**明确为进程外后端留了位置**：

> Provider-side vocabulary for OUT-OF-PROCESS subagent backends — the pieces that enforce this seam's own contracts around a child in another process... Backends compose these with their own wire drivers; the process machinery itself (spawn, env scrub, managed-range teardown) belongs to the `dsh-subprocess` seam.

并且注释里直接点名了 `subagent-acp` 作为消费方的诊断前缀示例。也就是说，**DSH 官方预期会有人写一个"通过 ACP 驱动进程外子 Agent"的 provider**。

同时，进程外后端有一个明确的能力约束（这是必须知道的限制）：

> The capability advertisement of an out-of-process backend: NONE. A child in another process cannot honor parent-enforced start features (`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a request needing any of them before `start` runs — never accepted-then-ignored.

**重要澄清**：`subagent-acp` 这个名字只出现在 `dsh-subagent` 的类型注释里作为示例，**DSH 0.2.0-rc.1 与 rc.2 的发行包中都不存在该包**（实测两个版本的 `@deepseek-ai` 目录下只有 `dsh-acp` 与 `dsh-acp-app`）。所以这是"宿主预留的扩展位"，不是"已经现成的能力"。

**方向性提醒**：DSH 自带的 `dsh-acp` 是 **ACP 服务端**（"Automation-only Agent Client Protocol **server** over JSON-RPC stdio"），用途是**把 DSH 自己的 Agent 暴露给外部 ACP 客户端**（如编辑器）。它**不是**消费外部 ACP Agent 的客户端。这两个方向不能混淆——本插件要做的是后者。

**本插件的现状**：已经探测了这个 seam。`src/dsh-capabilities/routes.ts` 中：

```ts
add({
  id: 'subagent-continuable-020', capability: 'subagent.continuable', ...
  detect: (ctx) => hasMethods(read(ctx, 'subagents'), ['startContinuable', 'sendMessage']),
  create: (ctx) => read(ctx, 'subagents'),
})
```

但当前只做了**能力探测**，还没有注册自己的 `SubagentProvider`。这为 spec007 的 Provider 原生路径留了口子，也说明"外部 Agent 成为 DSH 原生子 Agent"在技术上有一条官方认可的路——只是需要自己写 provider。

### 3.2.1 身份与历史的所有权划分

`codex-host` 的身份模型规定得很细（`.agents/skills/codexhost-add-harness/references/thread-lifecycle-and-history.md`）：

| 身份/数据 | 所有者 | 用途 |
| --- | --- | --- |
| Host Thread ID、Host Turn ID、映射事务 | **Host** | Desktop 身份、实时事件关联、持久化协调 |
| `NativeSessionRef` | 插件提供，Host 保存 | 重启后定位同一原生 Session |
| `NativeTurnRef` | 插件提供，Host 对齐 | 识别同一个原生逻辑 Turn，**不代表可 Fork** |
| `NativeCheckpointRef` | 支持 Fork 的插件提供 | 标识可精确派生的历史边界，**不是文件快照** |
| 原生消息、分支、Transcript 格式 | 对应 Harness / 插件 | 原生事实源及其公共快照投影 |

并明确规定：**插件不直接写 Host Mapping Store**，也不重新实现 Host 的 Thread 锁、导入去重和替换事务。

本插件的对应划分（`src/host/cli-adapters/driver.ts` 与 `session-store.ts`）：

| 身份/数据 | 所有者 | 用途 |
| --- | --- | --- |
| DSH sessionId、Host 会话表 | **插件 Host 侧** | DSH 会话绑定 |
| `providerSessionId` | 驱动提供，Host 保存 | 恢复外部会话 |
| `rawStoreRef` | 驱动探测提供，Host 保存 | 只留在 Host 的原始存储位置 |
| 外部 Transcript 格式 | 各驱动 | 通过 `probeSession` 只读校验 |

**共同点**：两侧都把"身份映射"和"原生事实源"分开，都要求插件不伪造身份、不伪造历史。**差别**：Codex Desktop 侧把 checkpoint 建模成公共类型（支持 Fork 的适配器必须提供），本插件的能力枚举里**没有 Fork/checkpoint 的位置**，所以这类能力只能留在驱动内部或文档里。

### 3.2.2 输出与交互契约

`codex-host` 的输出契约（`output-and-interactions.md`）规定：

```text
接受 turn.start（拒绝的调用不输出生命周期事件）
  → turn.started
  → item.started
  → item.updated（零次或多次，可与其他 Item 交错）
  → item.completed
  → 所有 Interaction 关闭、所有 Item 终结
  → 唯一 turn.completed
```

并有几条硬约束，对本项目有直接参考价值：

- **接受与完成不同**：RPC 请求返回或 SDK 文本结束，不一定代表 Agent/工具已完全结束。
- **每个接受的 Turn 都终结**，包括失败、取消和关闭；终态后不再为它发 Item 更新。
- **Tool 失败不自动等于 Turn 失败**：Agent 恢复后仍可能成功，按原生最终状态决定 outcome。
- 插件负责**原生请求/回调关联和归一化**，Host 负责公共交互到 Desktop 的关联与投影；不要新增原生事件透传通道。

本插件的 `CodingNsAgentEvent` 更扁平：只有 7 种事件，没有 `item.started/updated/completed` 的三段式生命周期。这在 Codex Desktop 侧会显得"信息不够"，但本插件的工具事件用 `status` 字段（`running`/`completed`/`failed`）表达状态，由消息 projector 投影到 DSH。

**对本项目的启示**：`tool-event` 的 `status` 语义应当遵守同样的原则——**工具失败不等于轮次失败**，轮次终态由 `finish` 事件单独表达。这一点在当前驱动实现中已基本遵循。

### 3.3 UI 与交互能力的归属不同

| 能力 | Codex Desktop 侧 | DSH 侧 |
| --- | --- | --- |
| Agent 选择器 | 适配器注入 renderer 扩展 | 插件注册 `conversation.input.right` 插槽 |
| 会话列表 | 外部 Harness Thread 进入官方列表 | 插件自有会话列表（外部会话走 DSH 原生侧栏集成） |
| Edit Diff | 桌面应用原生渲染 | 由插件投影为 DSH 工具事件 |
| Fork / 回滚 | 桌面应用提供 UI 入口 | DSH 有会话 fork 能力，但外部 Provider session 需插件自己处理 |
| 权限审批 UI | 桌面应用原生审批组件 | DSH 有 approval 体系（`dsh-client-ui-approval`），插件通过标准权限入口对接 |
| 提问 UI | 桌面应用原生提问组件 | DSH 有 user-questions 体系，插件通过标准入口对接 |
| 详情面板 | 桌面应用原生 | **必须插件自己做**（spec007 需求 6） |

Codex Desktop 一侧的 UI 是"宿主给什么就能用什么"，适配器把外部事件投影成公共 Item 即可。DSH 一侧的 UI 是"插件按契约注册自己的 UI"，灵活但要自己实现更多东西。

### 3.4 升级风险与稳定性

**Codex Desktop 侧**：
- 依赖 **CDP / Electron Inspector** 扩展官方桌面应用。这是浏览器调试协议层面的耦合，官方桌面应用升级（Electron 版本、进程结构、Inspector 可用性）都可能影响它。
- 依赖**官方 app-server 的协议形态**：CLI Shim 要在它前面透传请求，app-server 的启动方式或协议变化会影响 shim。
- 更脆弱的是 **Renderer 内部结构内省**。`packages/desktop-control/src/renderer-host-discovery.ts` 会扫描 React Fiber hook 链来找原生的 request manager：

  ```ts
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
  for (let index = 0; hook && index < 120; index += 1) { /* 遍历 hook 链找 manager */ }
  ```

  匹配条件还要求 `sendRequest`、`prewarmThreadStart`、`enqueueRequest`、`prewarmedThreadManager.discardAllPrewarmedThreads` 同时存在。这类结构一旦被上游重构就会失配。
- 官方仓库自己记录了多个版本的具体破坏（26.814 的 `clear-prewarmed-threads-for-host` RPC 被移除、26.908 的 Request Manager 被包装成 `{hostId, manager, status}`、draft 身份从 7 槽 atom 变成 13/19 长度元组），并明确声明这些是"版本相关的 Desktop JavaScript 绑定，**不是 Harness SDK 契约**"。
- 适配器还依赖各自的私有扩展（如 CodeBuddy 的 `_codebuddy.ai/resolveInterruption`、Cursor 的 `cursor/ask_question`），`codex-host` 自己在文档里反复标注"版本特定"。
- 官方文档也承认部分路径"并非对外承诺的稳定接口"（例如 WorkBuddy 的应用内打包路径、`ACC_PRODUCT_CONFIG_PATH`）。
- 插件化本身尚未完成（Renderer 仍有静态联合类型与每 Harness 字段），说明这条路的"动态接入"目标仍在演进中。

**但有一个重要的缓冲设计值得本项目借鉴**：这些私有依赖**全部收敛在 `desktop-control` 与 `renderer-extension` 两个宿主公共层包里**，适配器插件本身不碰 DOM/React/Electron 私有 API（架构文档把"插件访问 Desktop 内部 DOM、React 状态、Electron 私有 API 或 RequestManager"列为非目标）。所以升级 Codex Desktop 破的是公共层，**适配器不用改**。这正是本项目"适配器必须位于 `src/dsh-capabilities/` 边界层"的同类思路。

**DSH 侧**：
- 依赖的是**公开插件契约**（Cordis bundle、官方 Slot、RPC、能力 seam）。
- 本插件还有一层**版本路由矩阵**（`src/dsh-capabilities/`）兜底：每个能力有 `detect`/`create` 与降级策略，DSH 版本变化时只改矩阵与路由，不改业务模块。
- 但 DSH 的公开契约也在演进（本插件已跨 0.1.5-rc.3 → 0.2.0-rc.1），所以"稳"是相对的：稳在**有官方契约可依且可诊断**，而不是稳在**不会变**。
- **关键对比**：DSH 侧的耦合点是**公开 API 的形状**（可探测、可诊断、可降级）；Codex Desktop 侧的耦合点是**私有实现的内部结构**（React Fiber 链、atom 元组形状），只能靠 fail-closed + 现场探针发现，且失配时用户看到的是"Agent 不可用"。

### 3.4.1 两侧的 fail-closed 策略对照

`codex-host` 把 fail-closed 作为**宿主层的默认防御**，而不是交给适配器决定：

- 审批投影失败时，Host 不放弃，而是**主动拒绝**该审批（`#denyApproval`）。
- 适配器响应失败时，Host **取消整个 Turn**。
- 提问投影失败时，Host 发 `{ answers: {}, cancelled: true }`。
- 路由前缀下的非法数据**直接报错，绝不回落到官方 Codex**。
- 私有结构识别失配时 fail-closed，"不根据压缩类名或函数源码回退"。

DSH 侧有同样的原则，但落在不同位置：

- `ctx.approval` 的语义是 **"Missing answerers fail closed; grants apply only to the requested action"**——即**默认拒绝**，且授权只作用于被请求的动作。
- 本插件的 `CodingNsCliDriver` 对未声明能力返回结构化诊断（`DSH_TEAM_NATIVE_UNAVAILABLE` 一类），不伪造成功。

**对 spec007.1 的含义**：两侧都要求"不伪造成功"，但 DSH 侧的 fail-closed 由 `ctx.approval` 承担，插件的责任是**把应答方接对**；如果插件没有把外部 ACP 的权限请求正确映射到 `ctx.approval`，用户会看到"请求被自动拒绝"而不是"弹出审批框"。这是接入 ACP 类适配器时最容易出错的地方。

### 3.4.2 宿主能力反向限制适配器的案例

`codex-host` 里有一个清晰的例子：`HostTextQuestion` 允许声明 `secret: true`，但 `codex-question.ts` 在投影时直接抛错：

```ts
if (question.type === "text") {
  if (question.secret) {
    throw new Error("Current Codex Desktop does not safely render secret Question input");
  }
}
```

即：**适配器可以声明这个能力，但宿主渲染不了，最终结果是 fail-closed 取消**。

**对本项目的含义**：DSH 的插槽与事件模型也有表达能力上限。声明能力前必须先确认 DSH 侧有对应出口，否则同样会出现"驱动声明了、界面表达不了"的落差。这正是接入规范 §4 要求"每个声明项必须能指向一次真实交互"的原因。

### 3.5 能力上限与代价

`codex-host` 在能力上确实更强，代价是更脆：

- **强**：外部 Harness 能拿到桌面应用的 Fork、Edit Diff、消息编辑、slash 命令等完整 UI；用户感知"像原生一样"。
- **脆**：任何一处注入点或私有扩展变化都可能让某个适配器静默失效；`codex-host` 的文档里大量篇幅在描述"某版本某行为不可靠"。

DSH 侧能力上限受宿主模型约束（外部 Agent 不能进官方 Team 面板、不能成为 DSH Agent），但契约稳定、可降级、可诊断。

### 3.6 插件信任模型：两侧都是"安装即信任"，但边界不同

`codex-host` 的运行时文档写得很直白：

> **启用的插件是可信本机代码，不是沙箱代码。** 工厂在 Host 进程内运行，具有该进程的权限，并能读取传入的环境变量，包括其中可能存在的凭据。路径和元数据校验不能防止可信插件主动导入其他文件、访问网络、调用 `process.exit` 或阻塞事件循环。

其 `enabled.json` 是**显式执行许可**，不是发现缓存；跨根目录出现同 ID 时两份都拒绝加载。异步超时也无法中断同步阻塞或隔离 `process.exit`。

本插件的信任模型同类：它是 DSH 进程内的 Cordis 插件，拥有 Host 进程权限。差别在于本插件有**能力路由矩阵**这一层：即使某个 DSH API 缺失或形状变化，也能给出可解释诊断并降级，而不是直接崩掉整个 Host。

**结论**：两侧都没有沙箱。这不是设计缺陷，而是"本机插件"这一类产品的固有前提。因此 spec007.1 的接入规范把"不写凭据、不泄露路径"列为硬要求，而不是依赖运行时隔离。

## 四、对 spec007.1 选型的直接影响

这些差别会**改变同一批适配器的集成价值判断**：

1. **不能照搬 codex-host 的能力清单**。`codex-host` 的 README 给某适配器标的 ✅（例如 Fork、Edit Diff、slash 命令），前提是**桌面应用提供了对应 UI**。DSH 侧这些能力需要插件自己实现或根本没有对应出口。直接抄矩阵会得到虚高的预期。

2. **ACP 类适配器在 DSH 侧更划算**。ACP 是双向协议，权限与提问可以应答，正好对应 DSH 的 approval / user-questions 体系。这正是选型矩阵把 `cursor-cli`、`kiro-cli`、`qoder` 排在前面的原因。

3. **权限不可应答的路径在 DSH 侧体验更差**。Antigravity（只有 always-dangerous）与 ZCode（`-p` 模式 deny broker）在 DSH 里意味着 `permission` 能力永久不可用，而 DSH 本身有完整的审批 UI，落差比在 Codex Desktop 里更明显。

4. **spec007 的 Provider 原生路径有了明确落点**。`ctx.subagents` seam + "out-of-process backend 能力广告为 NONE" 的约束，说明外部 Agent 可以作为**进程外子 Agent**接入 DSH，但不能伪装成进程内子 Agent 去享受 `agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`。这应当写进 spec007 的能力声明。

5. **codex-host 的私有兼容层不要移植**。Cursor 的 SQLite+PTY Fork 桥、Antigravity 的 PreToolUse Hook 提问桥、CodeBuddy 的私有 ACP 扩展——这些都是为了适配 Codex Desktop 的私有环境而做的，搬到 DSH 侧只会增加维护面且未必可用。

### 四之补充：DSH 侧可直接复用的官方 seam

与 Codex Desktop 侧"适配器自己造进程与审批"不同，DSH 已经提供了三个可复用的 seam，实施时应优先接入而不是自研：

| seam | 包 | 能力 | 对外部 Agent 适配器的意义 |
| --- | --- | --- | --- |
| `ctx.subprocess` | `@deepseek-ai/dsh-subprocess` | 托管进程组、有界 spill 输出、升级 kill | 可直接替代插件自研的子进程清理逻辑 |
| `ctx.approval` | `@deepseek-ai/dsh-user-approval` | 一次性权限决策，经 approval/request waterfall 分派给已组合的应答方，**默认 fail-closed** | ACP 类适配器的权限请求应走这里，而不是插件自造审批 UI |
| `ctx.userQuestions`（`dsh-user-questions`） | `@deepseek-ai/dsh-user-questions` | 结构化用户提问 | 适配器的提问事件应映射到这里 |

这与本插件当前的做法一致：`CodingNsCliDriver` 已声明 `respondPermission`/`respondQuestion`，且客户端已有 `dsh-client-ui-approval`、`dsh-client-ui-user-questions` 可承载 UI。

**注意 fail-closed 语义**：DSH 的 approval 默认拒绝。这与 ZCode `-p` 模式的 deny broker 表现相似，但区别在于——DSH 的 approval 是**有应答方的**，只要插件正确接线，用户就能审批；而 ZCode `-p` 模式是**根本没有应答通道**。这正是选型矩阵要求 ZCode 不声明 `permission` 的原因。

### 四之补充二：codex-host 给适配器开发者的硬约束（可对照借鉴）

从其新增 Harness 的开发者规范里可以提炼出这些约束，其中多条对本项目同样适用：

1. **不支持的分支返回类型化 `unsupported`，不伪造成功。** 存在接口不等于必须支持所有原生操作。
2. **既有特例是兼容负担，不是新适配器的实现模板。** 公共契约无法表达真实需求时，记录缺口并设计公共扩展，**不得通过新适配器专用的 Host 分支绕过契约**。
3. **不得为形式统一而重写既有 Transport。** 各适配器保留自己的原生协议。
4. **读取静态命令元数据不得触发 `inspect()`、连接原生服务或打开会话。**
5. **`open()` 必须识别 create/resume/fork/rollbackLastTurn 全部分支**，并在产生副作用前拒绝不支持的分支。
6. **身份可持久化前不声称可恢复**；原生失败/取消未落盘时不伪造 `NativeTurnRef`。
7. **历史损坏、分页缺失或无法确定终态时明确报错或返回类型允许的 unknown，不猜测成功。**
8. **插件负责原生请求/回调关联与归一化**；不新增原生事件透传通道，不让 Renderer 解释原生 SDK 对象。
9. **私有依赖收敛在边界层**：适配器插件不接触 DOM/React/Electron 私有 API。

**对本项目的映射**：第 1、4、6、7 条在本插件里已有对应约定（`detect()` 无副作用、`probeSession()` 只读、能力缺失返回结构化诊断）；第 2 条与本项目"不把版本判断散落到业务模块"的要求一致；第 9 条对应本项目的"适配器必须位于 `src/dsh-capabilities/` 边界层"。**第 3 条值得特别注意**：本插件同样不应为统一而重写各驱动已有的传输实现。

## 五、集成到 Codex Desktop 的固有技术特征

以下 12 条刻画"这个宿主强制你做什么、限制你做什么、哪些能力是宿主管的"：

1. **宿主是别人家的桌面应用，只能借用它的 UI，不能定义 UI。** Codex Desktop 负责消息渲染、Edit Diff、审批/提问对话框、Fork 入口、命令菜单；适配器只产出 `HostItem` / `HostInteraction` 数据。**无法新增一种 UI 形态**——要加新交互形式必须改 `renderer-extension` 与 `protocol-core`，那是宿主代码。

2. **"接入"分成两个难度不同的层，且第二层没做完。** Host 侧已完全动态（插件加载器 + `enabled.json` + Manifest），Renderer 侧仍是静态联合类型（16 项 `KNOWN_RENDERER_AGENTS` + 每 Harness 一组 `DraftComposerState` 字段 + 硬编码 `enabledAgents`）。**新 Agent 不会自动出现在 Picker 里**。

3. **插件不能碰私有 API，但宿主自己必须重度依赖私有 API。** 架构文档把"插件访问 Desktop DOM/React/Electron/RequestManager"列为非目标；所有 Fiber 内省、CDP 注入、额度门改写都集中在 `desktop-control` / `renderer-extension`。**升级 Codex Desktop 破的是宿主公共层，不是适配器**——这是与"每个适配器各自适配宿主"模式的本质区别。

4. **适配器契约被刻意设计成"宿主管编排、插件管原生"。** `HarnessSession` 只有 `execute`/`readSnapshot`/`outputs`/`close` 四类方法；线程映射、持久化事务、Fork/回滚 UI 入口、事件投影、交互关联、fail-closed 策略、超时与并发锁全在 Host。

5. **Fork 与回滚是适配器的责任，宿主只提供 UI 入口和编排。** `open()` 的四个分支全部由适配器实现；宿主校验前置条件，但"原生怎么做到恰好少一个逻辑 Turn"是插件的事。原生不支持必须返回 `unsupported`。

6. **"requested ≠ effective" 是硬性语义。** 适配器必须区分"还没读到"和"已确认不存在"，不能从旧持久化值复活已清除的 Thinking/权限，不能在原生确认前发布配置值。

7. **fail-closed 是默认行为，不是可选项。** 审批/提问投影失败 → Host 主动拒绝或取消 Turn；路由非法 → 报错且**绝不回落到官方 Codex**。

8. **宿主对适配器输出有严格的形态约束，很多是 schema 级强制。** `HostFileChange` 必须带 `unifiedDiff`；`HostUsage` 拒绝未知字段且 `contextUsedTokens`/`contextWindowTokens` 必须成对；`forkAcrossCwd` 蕴含 `fork`。翻译不了的必须报告限制。

9. **存在"宿主能力反向限制适配器"的案例。** `HostTextQuestion` 允许 `secret: true`，但 Desktop 渲染不了，投影直接抛错 → fail-closed。

10. **插件是受信任的进程内代码，没有沙箱。** 文档原文："启用的插件是可信本机代码，不是沙箱代码。"权限模型实质是"安装即信任"。

11. **跨设备/远程是"每连接独立插件目录"，不是"一份插件服务多端"。** SSH listener、Remote Control、Aqua Broker 各自从自己 Runtime 旁的 `plugins/` 加载；搬移 Runtime 时必须一起搬 `plugins/`。

12. **升级风险是结构性的、无法通过设计消除。** 依赖清单里有 React Fiber hook 链、Composer Model atom 元组形状、`prewarmedThreadManager.discardAllPrewarmedThreads`、`steerTurn`/`startTurn`/`getTurnCoordinator()`、额度门 atom 读取序列。文档自己承认"这些是版本相关的 Desktop JavaScript 绑定，不是 Harness SDK 契约"，并记录了 26.814、26.901、26.903、26.908 四个版本的具体破坏。唯一防御是 fail-closed + 现场探针 + 每次升级重跑诊断。

## 六、待确认项

1. `ctx.subagents` 注册一个进程外 provider 的完整契约（`SubagentProvider` 的字段与生命周期）与失败语义。
2. DSH 的 approval / user-questions 体系与外部 ACP 权限请求的对接方式（本插件已有 `respondPermission`/`respondQuestion`，需确认与原生 UI 的映射）。
3. 外部 Provider session 与 DSH 会话 fork 的关系：DSH 的 `session.format-v4` 与外部 session 标识如何共存。
4. `dsh-subprocess` seam 的进程管理能力（env scrub、managed-range teardown）能否直接复用于外部 CLI 子进程，避免插件重复实现进程清理。
5. 若未来 DSH 发布官方 `subagent-acp` 包，本插件是复用它还是保留自研驱动。

## 七、证据来源

- `codex-host` 仓库（HEAD）：
  - 架构与契约：`docs/architecture/harness-plugin-architecture.md`、`harness-plugin-runtime.md`、`harness-session-import.md`、`harness-command-integration.md`、`external-thread-steering.md`
  - 适配器开发规范：`.agents/skills/codexhost-add-harness/SKILL.md` 与 `references/` 下的 `public-adapter-contract.md`、`thread-lifecycle-and-history.md`、`output-and-interactions.md`、`registration-and-validation.md`、`renderer-product-integration.md`、`current-harness-implementations.md`
  - 公共契约源码：`packages/harness-adapter/src/text-session.ts`（`HarnessAdapter` / `HarnessSession` / `OpenSessionInput`）、`packages/shared-contracts/src/native-refs.ts`、`harness-plugins.ts`、`harness-route.ts`
  - 注入与宿主实现：`crates/launcher/src/desktop_attachment.rs`、`crates/shim/src/desktop_invocation.rs`、`packages/desktop-control/src/renderer-cdp-control-session.ts`、`renderer-host-discovery.ts`、`production-controller.ts`、`packages/renderer-extension/src/agent-selection-state.ts`、`packages/protocol-core/src/codex-question.ts`、`packages/host-runtime/src/external-thread-runtime.ts`
  - 版本破坏记录：`docs/archive/codex-desktop-incidents/26.814-compatibility-debt.md`、`26.908-request-manager-wrapper.md`、`docs/operations/codex-desktop-upgrade-diagnosis-playbook.md`
- 本插件源码：`package.json`（`dsh` 字段）、`dsh.bundle.patch`、`src/client/cli-slots.ts`、`src/host/cli-adapters/feature.ts`、`src/host/cli-adapters/native-team-proxy.ts`、`src/dsh-capabilities/routes.ts`、`src/dsh-capabilities/types.ts`
- DSH `0.2.0-rc.1` 运行时（`~/.local/share/codingns/deepseek-harness/0.2.0-rc.1/node_modules/@deepseek-ai/`）：
  - `dsh-subagent/lib/types/index.d.ts`（`ctx.subagents` seam 定义）
  - `dsh-subagent/lib/types/out-of-process.d.ts`（进程外后端能力广告为 NONE）
  - `dsh-acp/lib/types/index.d.ts`（ACP **服务端**定位）
  - `dsh-experimental-agent-team/lib/types/types.d.ts`（`SpawnTeammateRequest` 字段）
  - `dsh-agent/lib/types/index.d.ts`（`AgentRegistry` / `CreateAgentOptions`）
  - `dsh-llm/package.json`（provider 是模型提供商）
- 同目录 `0.2.0-rc.2` 用于交叉验证 `subagent-acp` 包不存在

**证据等级**：DSH 侧的结论均来自本机已安装运行时的类型定义（A 级）；Codex Desktop 侧的结论来自 `codex-host` 的文档与源码（B 级，属同类宿主的实现说明）。两侧的对照结论为本文件的分析。

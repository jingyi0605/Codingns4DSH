# 设计文档 - 编程助理语音汇聚与实时对话

状态：Draft（阶段 1 已据实测回写；2026-10-05 已接入按需加载的 `sherpa-onnx-node`）

## 1. 概述

### 1.1 目标

- 建立覆盖**受管工作区范围内、未归档会话**的索引，作为一切汇总与派发的事实来源。
- 让用户**手动控制**助理能看哪些工作区，范围之外不读取。
- 通过可替换的 `VoiceRuntimeAdapter` 接入按需加载的 `sherpa-onnx-node`，由 Sherpa 提供流式 ASR、可选 VAD 和本地模型能力；CodingNS 负责 Client 设备、Host 租约、事件归一化、范围索引和动作桥。
- 复刻 `voiceAgent` 服务契约，使语音对话能力归属 CodingNS 自己，不被第三方插件的发布节奏与供应商绑定牵制。
- 把「问进展」和「下指令」建模为两个已注册动作，意图路由只负责选择动作与抽取参数。
- 派发复用 `sessionController.prompt`，不新建第二条投递通道。
- 索引构建**不影响 DSH 主进程性能**，不阻塞会话处理。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 10，以及全部非功能需求。

### 1.3 技术约束

- **不修改 DSH 核心**。只消费其公开服务。
- Host 侧可用的核心服务：`ctx.sessionQuery`、`ctx.sessionController`、`ctx.workspaceRegistry`、`ctx.llm`、`ctx.settings`。
- Client 侧可用的核心服务：`ctx.sessions`（`list` / `scope` / `refresh` / `open`）、`ctx.workspaces`、`ctx.conversation.input`、`ctx.uiSession`。
- Client 通过适配器调用浏览器实时设备 API；连续音频由 CodingNS 同源 PCM 流路由承载，JSON RPC 只传租约、状态、转写和动作结果。
- 浏览器 Client 是 Web 场景唯一的硬件入口：设备枚举与选择留在 Client，Host 只接收带租约的控制与状态事件；局域网访问必须满足浏览器安全上下文要求。
- 语音能力按 spec005 的 capability 边界挂载，不做散落的版本判断。
- **索引范围恒为「受管工作区 ∩ 未归档」**，任何绕过该范围的读取都是缺陷。
- **`sessionQuery.filterSessions()` 无 archived 谓词**（已核实谓词只有 `id`/`cwd`/`created-at`/`parent`/`availability`），归档过滤必须在索引层自行完成。

## 2. 架构

### 2.1 系统结构

```text
                     用户唤醒或插话
                          │
             ┌────────────▼────────────┐
             │ Client 设备管理与音频采集 │
             │ MediaDevices/getUserMedia│
             │ AudioWorklet/播放控制    │
             └────────────┬────────────┘
                          │ 同源 HTTPS PCM 数据面
             ┌────────────▼────────────┐
             │ Host 全局语音协调器      │
             │ Host 级唯一租约/epoch      │
             └────────────┬────────────┘
                          │ VoiceRuntimeAdapter
             ┌────────────▼────────────┐
             │ sherpa-onnx-node        │
             │ ASR · VAD · TTS          │
             │ Host 模型运行时          │
             └────────────┬────────────┘
                          │ 事件/动作
                          ▼
              ┌───────────────────────┐
              │  意图路由（Host）      │  ← 本 Spec 新增
              │  汇总 / 派发 / 澄清    │
              └───────┬───────┬───────┘
                      │       │
        汇总意图      │       │      派发意图
                      ▼       ▼
   ┌──────────────────────────┐  ┌──────────────────────┐
   │  会话汇聚索引（Host）     │  │  派发器               │
   │                          │  │  sessionController    │
   │  listSessions()  ← 全集  │  │  .prompt({sessionId}) │
   │      │                   │  └──────────┬───────────┘
   │      ├─ 受管工作区过滤 ────┼── 用户勾选 │ queue / steer
   │      ├─ 排除已归档 ───────┼── 454 个   ▼
   │      ▼                   │  ┌──────────────────────┐
   │  索引范围（90 个活跃）    │  │  目标会话（本机/远端） │
   │  + PeerHost 聚合         │  └──────────────────────┘
   └────────┬─────────────────┘
            │ 索引快照
            ▼
   ┌──────────────────┐
   │  摘要生成 ctx.llm │
   └────────┬─────────┘
            │ 摘要文本
            ▼
   ┌──────────────────┐
   │  语音播报（TTS）  │
   └──────────────────┘
```

全局语音协调器不保存目标 `sessionId`。三层职责必须分开：**语音运行时只负责音频进出，汇聚层只负责事实，意图层只负责路由**。派发器收到带索引代次的目标引用后，必须重新检查受管范围与归档状态。

索引层额外承担两个**裁剪**职责：按受管工作区过滤、排除已归档会话。这两步在架构上属于汇聚层，不泄漏到意图层与语音层。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `assistant-scope.ts` | 受管范围的读写与持久化 | 用户选择、`workspaceRegistry` | `AssistantScope` |
| `assistant-session-index.ts` | 按范围与归档状态构建并缓存会话索引 | `sessionQuery`、`workspaceRegistry`、PeerHost 聚合 | `SessionIndexEntry[]` |
| `assistant-summary.ts` | 纯逻辑：把索引转成结构化摘要与播报文本 | 索引快照、可选会话内容 | 摘要对象、播报文本 |
| `assistant-dispatch.ts` | 目标解析与投递 | 目标描述、任务文本、索引 | 投递结果或澄清请求 |
| `assistant-intent.ts` | 纯逻辑：自然语言 → 意图 | 转写文本、索引 | `AssistantIntent` |
| `voice-agent-service.ts` | 复刻的 `voiceAgent` 服务 | 供应商适配、动作注册表 | 会话句柄、事件流 |
| `voice-agent-actions.ts` | 把汇总与派发注册为动作 | 上述模块 | 注册句柄 |
| `global-voice-coordinator.ts` | Host/Profile 级全局语音会话、逻辑租约、epoch 和运行时事件 | `VoiceRuntimeAdapter`、索引快照 | 全局语音状态与动作输入 |
| `sherpa-onnx-node`（按需外部包） | Host 侧流式 ASR、可选 VAD/TTS | 动态 import、模型环境配置 | partial/final/audio 事件 |
| `shared/contracts/voice-runtime.ts` | CodingNS 运行时能力、事件、epoch 和租约边界 | 适配器事件 | 稳定内部契约 |
| `sherpa-voice-adapter.ts`、`voice-capture.ts` | 对接浏览器设备、PCM 流、epoch 和句级播报 | `MediaDevices`、同源流路由、`speechSynthesis` | 全局输入、设备切换、barge-in |
| `voice-output.ts` | 文本清理、按句播报队列和可中断降级 | 摘要文本、浏览器输出 | 播报状态 |

纯逻辑模块（`assistant-summary`、`assistant-intent`）不依赖 DSH 服务，可以直接单元测试，这是本设计刻意的选择：**意图解析和摘要格式化是最容易出错、也最需要测试的部分，不应与 I/O 纠缠**。

## 3. 会话汇聚与索引

### 3.0 索引范围（两个硬约束）

索引**不是**"全部会话"，而是：

```text
索引范围 = 用户勾选的受管工作区  ∩  未归档会话
```

两个约束都来自实测数据，不是功能裁剪。

#### 3.0.1 约束一：仅索引未归档会话

实测本机：

| 指标 | 值 |
| --- | --- |
| 磁盘唯一会话 | 543 |
| **已归档会话** | **454（83.6%）** |
| **未归档（活跃）会话** | **89** |
| 归档会话磁盘占用 | 284.5 MB（**占 90.4%**） |
| 活跃会话磁盘占用 | 30.2 MB |
| 全量扫描耗时 | **6.56 秒** |
| **仅扫描活跃会话** | **1.03 秒** |

**仅索引未归档会话即可提速 6.4 倍、减少 86% 读取量。** 这同时解决两个问题：性能，以及"把几个月前结束的工作报成当前进展"的语义错误。

归档状态由 `ctx.workspaceRegistry` 的 `archivedSessionIds` 提供（实测本机 **454 条**）。

⚠️ **`sessionQuery.filterSessions()` 没有 archived 谓词。** 已核实的谓词只有 `id`、`cwd`、`created-at`、`parent`、`availability`（`lib/index.js:675-702`）。**归档过滤必须在索引层自行完成**，不能指望查询服务代劳。

#### 3.0.2 约束二：仅索引受管工作区

用户手动勾选受管工作区。范围之外的工作区**不被读取**，其会话不出现在索引与摘要中。

这既是隐私边界（不读用户不想让助理碰的目录），也是性能边界（范围越小越快）。

范围设置持久化在插件自己的设置中，通过 `ctx.settings` 或等价机制保存，**不写入 DSH 核心配置**。

### 3.1 数据来源

| 来源 | 用途 | 边界 |
| --- | --- | --- |
| `ctx.sessionQuery.listSessions()` | 会话全集 | 返回 `{ header, live, persisted }` 包装对象，**不是**扁平记录 |
| `ctx.workspaceRegistry` | **受管范围**、工作区归属、**归档集合** | 只读；提供 `archivedSessionIds` 与工作区列表 |
| `ctx.sessionQuery.readTitleSnapshots(ids)` | 批量标题 | 比逐会话读取便宜 |
| `ctx.sessionQuery.readSurface(id)` | 生成摘要所需的会话内容 | **已过滤为模型表层**，避开流式 chunk |
| PeerHost 聚合（spec006） | 远端 Host 的会话 | 复用既有通道，不新建 |

**过滤顺序**（每一步都缩小后续工作量）：

```text
listSessions()                    ← 全集（543）
   │
   ├─ 按 workspaceRegistry 过滤受管工作区
   │
   ├─ 排除 archivedSessionIds       ← 剔除 454 个，剩 89 个
   │
   ▼
索引范围（实测 89 个活跃会话）
```

**为什么用 `listSessions()` 而不是只用 `workspaceRegistry`**：实测注册表只登记 484 个会话，磁盘有 543 个，**59 个游离在注册表之外**（`delegationDepth` 全为 0，不是子代理）。但受管范围生效后，这些游离会话只有在用户勾选了其 `cwd` 对应的工作区时才会被纳入 —— 游离会话不再是一个必须处理的问题，而是"工作区未勾选"的自然结果。

### 3.2 索引结构

```ts
interface SessionIndexEntry {
  sessionId: string
  title: string | null          // 缺失为 null，不猜
  workspaceId: string           // 受管范围内的会话必然有归属
  workspaceName: string
  hostId: string                // 本机为固定标识
  running: boolean
  completed: boolean
  updatedAt: number | null
  waiting: 'approval' | 'question' | null   // 独立来源，见 3.4
}

interface AssistantScope {
  managedWorkspaceIds: readonly string[]    // 用户勾选，可为空
  includeArchived: false                    // 恒为 false，见 3.0.1
}
```

**`title` 允许为 `null`**。这是刻意的：实测 594 个格式文件中有 **43 个没有 `session/title` 事件**，把它填成 `sessionId` 会让摘要读出一串无意义 ID。

**`title` 必须取自会话日志中最后一条 `session/title` 事件**，不能取首条。原因是存在**暂态 HTML 标题**：实测有 6 个会话的首个 `session/title` 是 HTML 片段（形如 `<a class="btn btn-accent" href="...`），但末条已全部修正为正常标题。取首条会让播报读出一串标签，直接违反需求 3 验收标准 3。

`SessionHeader` 本身**不含 `title` 与 `workspaceId`**（已核实字段集为 `version`/`id`/`createdAt`/`cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth`/`agentPreset`），因此这两项都必须另行获取。

**注意**：因为索引范围已限定为受管工作区，`workspaceId` 不再是可空的（不再需要「未分组」兜底）。范围外的会话根本不会进入索引。

### 3.3 索引刷新策略

- 首次请求时全量构建。
- 后续通过 `ctx.on('session/event', ...)` 的 `turn/start`、`turn/end`、`user/message` 做增量更新。
- 摘要生成前如果索引超过 TTL（建议 30 秒），做一次轻量校验。
- **读取索引不得使冷会话变为 live**。`listSessions()` 本身不激活 Agent；`readSurface()` 只对需要摘要的会话调用，且限制数量。

**实测成本（本机 594 个格式文件 / 552,246 事件 / 334.8 MB 压缩数据）**：

| 操作 | 耗时 |
| --- | --- |
| 全量解压并扫描全部 594 个格式文件 | **6.56 秒** |
| 解压单个最大会话（5.38 MB → 13.0 MB / 19,921 事件） | **0.118 秒** |

全量扫描成本远低于预期，因此索引构建不需要复杂的增量优化；实际摘要只读取少量会话，成本可忽略。

### 3.3.1 必须避开流式 chunk

实测全量事件分布显示，**流式 chunk 类事件占了绝大多数**：

| 事件类型 | 数量 |
| --- | --- |
| `reasoning-chunks` | 77,424 |
| `assistant/chunk` | 39,992 |
| `tool-call-chunks` | 29,046 |
| `text-chunks` | 7,426 |
| **小计** | **153,888** |
| `user/message` | 333 |
| `assistant/message` | 4,208 |
| `turn/end` | 194 |
| `tool/call` / `tool/result` | 各 5,076 |

**摘要生成绝不能遍历原始事件日志。** 必须用 `readSurface()`（它已过滤出模型表层），或只读 `user/message`、`assistant/message`、`turn/end`、`tool/call` 这类语义事件。

### 3.3.2 不得自行读盘

会话存储实测有**三种格式版本并存**：

| 文件名 | 数量 | header `version` |
| --- | --- | --- |
| `session.v4.jsonl.zstd` | 364 | 4 |
| `session.v3.jsonl.zstd` | 212 | 3 |
| `session.jsonl.zstd` | 74 | 0 |

当前格式常量为 `SESSION_FORMAT_VERSION = 4`。任何绕过 `sessionQuery` 直接读文件的做法都必须自行处理三种格式与迁移链 —— **这是必须使用 `sessionQuery` 而非自行读盘的理由之一**，核心已封装 `v0-to-v1` … `v3-to-v4` 的迁移。

**更隐蔽的陷阱：文件数 ≠ 会话数。** 实测 **47 个会话同时存在多个格式文件**（如 `session.jsonl.zstd` + `session.v4.jsonl.zstd` + `session.v3.jsonl.zstd`），这是格式迁移的历史残留。结果是：

| 指标 | 值 |
| --- | --- |
| 格式文件总数 | **594** |
| 唯一会话 ID 数 | **543** |
| 多格式并存的会话 | **47** |

按文件枚举会话会**重复计数 51 个**（594 vs 543）。核心的持久化层已做格式识别与去重，自行读盘必然踩这个坑。

### 3.4 等待处理状态的获取

这是本设计最容易出错的地方：**`SessionSummary` 上只有 `running` 和 `completed`，没有「等待审批」。** 如果直接用它，会把「等用户点审批」的会话报成「运行中」，用户就永远不知道该去处理。

正确来源：

- Host 侧：监听 `approval/request` 与 `user-questions/request` 事件。
- Client 侧：`ctx.uiSession.pendingInteractions`。

索引中 `waiting` 字段必须来自这两处之一，不得由 `running` 推断。

### 3.5 性能影响分析

**问题：会话摘要提取是否会影响 DSH 以及插件的运行性能？**

结论：**在限定范围后，影响可忽略；不限定范围则有可感知风险。** 以下是实测依据。

#### 3.5.1 实测数据

| 场景 | 文件数 | 耗时 |
| --- | --- | --- |
| 全量扫描（含归档） | 594 | **6.56 秒** |
| **仅活跃会话** | 108 | **1.03 秒** |
| 单会话解压（最大 5.38 MB → 13.0 MB / 19,921 事件） | 1 | **0.118 秒** |

CPU/墙钟分解（全量）：`real 5.14s / user 2.24s / sys 2.25s` —— 说明**一半时间花在 I/O 与解压**，不是纯 CPU 燃烧。

#### 3.5.2 风险在哪里

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **阻塞 Host 事件循环** | 若在主线程同步解压，会阻塞会话处理 | 全部读取走**异步**路径，不阻塞 |
| **重复全量扫描** | 每次询问进展都重扫一遍 | 索引缓存 + 事件增量更新 |
| **读取量随历史增长** | 不限制范围时会随时间线性变慢 | 归档过滤 + 受管范围，二者都是**常量级**裁剪 |
| **摘要本身调用 LLM** | 生成摘要要调模型，有 token 成本 | 只对有变化的会话重新摘要；播报文本有长度预算 |

#### 3.5.3 为什么限定范围是有效的

两个约束都是**裁剪**，不是优化：

```text
543 个会话
  ├─ 排除归档 454 个  →  89 个
  └─ 再按受管工作区裁剪  →  通常更少
```

即使受管范围包含全部工作区，**归档过滤一项就能把工作量降到 1/7**。而实际使用时用户通常只勾选正在推进的几个工作区，范围会进一步缩小。

#### 3.5.4 设计要求

1. **索引构建异步执行**，不阻塞 Host 的会话处理路径。
2. **首次构建只在用户首次询问进展时触发**，不在插件加载时扫描（避免拖慢 DSH 启动）。
3. **缓存索引**，通过 `ctx.on('session/event', ...)` 增量更新，避免重复全量扫描。
4. **摘要读取有界**：只读需要摘要的会话，且只读 `readSurface()` 返回的表层事件。
5. **受管范围变化时重建**，而不是每次请求都重新过滤。

#### 3.5.5 验收指标

- 受管范围内 89 个活跃会话的索引构建 **< 1.5 秒**（实测 1.03 秒）。
- 索引命中缓存时，摘要生成前的准备 **< 100 毫秒**。
- DSH 会话处理路径**不出现可感知延迟**（索引构建期间仍可正常对话）。

## 4. 摘要生成

### 4.1 优先级

播报预算有限，压缩顺序固定为：

```text
等待处理（审批/提问） > 出错 > 运行中 > 刚完成 > 空闲
```

`requirements.md` 需求 7 要求等待处理项优先暴露，这里是它的落点。

### 4.2 播报文本约束

- 不含 Markdown 语法、代码块、URL、文件路径全称。
- 会话标题原样保留（用户认得自己的会话名），但不朗读其路径。
- 每类状态即使为空也要说一句，避免用户以为漏报。
- 涉及敏感字段（token、key、密码形态的字符串）时跳过该片段。

### 4.3 失败降级

单个会话读取失败时：

1. 记录该会话为「无法读取」。
2. 在摘要末尾以一句话说明有几个会话未能读取。
3. **不中断整体汇总**。

## 5. 意图路由

### 5.1 意图集合

| 意图 | 触发示例 | 动作 |
| --- | --- | --- |
| 汇总 | 「现在进展怎么样」「有什么在跑」 | 生成并播报摘要 |
| 派发 | 「让 X 去做 Y」 | 解析目标 + 投递 |
| 澄清 | 目标不唯一 | 反问，不猜测 |
| 闲聊/未识别 | 其它 | 交给对话模型自由回答，不触发副作用 |

### 5.2 目标解析

从口语描述到具体会话的解析顺序：

1. **精确匹配**会话标题。
2. **包含匹配**标题子串。
3. **工作区 + 序数**（「第二个会话」）。
4. **最近活动**（「刚刚那个」）。

**任一阶段命中多个候选时必须澄清**，不得按最近活动猜。这是 `requirements.md` 需求 6 验收标准 3 的直接落点。

### 5.3 派发模式选择

| 条件 | 模式 |
| --- | --- |
| 目标会话 `running === true` 且用户要求立即改变 | `steer` |
| 目标会话 `running === true`，用户未要求立即 | `queue` |
| 目标会话空闲 | `queue` |

`steer` 会把输入注入正在运行的轮次，语义上「打断并改方向」，因此只在用户明确表达时才用。

## 6. voiceAgent 服务复刻

### 6.1 复刻范围

参考实现的契约见 `docs/20261004-voiceAgent服务契约调查.md`。本 Spec 复刻其**契约面**，不复制其实现：

```ts
interface VoiceAgentService {
  capabilities(): VoiceAgentCapabilities
  startConversation(options: StartConversationOptions): Promise<VoiceConversation>
  registerActions(ownerPrefix: string, actions: Record<string, VoiceAction>): { dispose(): void }
}

interface VoiceConversation {
  id: string
  subscribe(listener: (event: VoiceEvent) => void): () => void   // 返回退订函数
  updateContext(context: unknown): void                          // 已关闭或未就绪时抛错
  resolveAction(callId: string, result: unknown, options?: unknown): void
  interrupt(): void
  end(): Promise<void>                                           // 幂等
}

interface VoiceAction {
  execute(args: unknown, control: { resolve(result: unknown, options?: unknown): boolean }): unknown | Promise<unknown>
  timeoutMs?: number
}
```

**注意三处容易写错的地方**（均已在参考实现代码中核实）：

1. `startConversation` **没有 `onEnd` / `onError` 回调**。事件一律通过 `subscribe()` 获取。回调式 API 属于 `readAloud` / `recognize`，不属于会话。
2. `control.resolve` **返回 boolean**，且幂等（重复调用返回 `false`）。
3. `action.arguments` 是**字符串**，不是对象；`action-result.output` 会做**递归 4000 字符截断**。

### 6.2 与参考实现的差异（有意为之）

| 项 | 参考实现 `dsh-realtime-voice` | 本 Spec |
| --- | --- | --- |
| 注册位置 | 浏览器 Client 侧 | **Host 侧**，使会话汇聚与派发同进程可达 |
| 服务名 | `voiceAgent`，另有别名 `realtimeVoice` | `voiceAgent`（别名可选，见下） |
| 运行时 | 绑定外部实时供应商 | CodingNS 按需动态加载 `sherpa-onnx-node`；包或模型缺失时返回结构化不可用状态 |
| 模型运行时 | 依赖 `dsh-multi-model-provider/realtimeModelRuntime` | Sherpa 模型由环境配置提供；CodingNS 业务模块只依赖 `VoiceRuntimeAdapter` |
| 动作匹配 | `ownerId.startsWith(ownerPrefix)` | 一致 |
| 超时语义 | 默认 300000ms，可按 action 覆盖 | 一致 |
| 事件名 | 9 种归一化事件（含未在契约文件声明的 `interrupted`） | 一致，并在契约中**完整声明** |
| 错误文案 | `'Unknown action: <name>'`、`'Invalid action arguments.'` | 一致（便于对照测试） |

**业务服务注册位置从 Client 改到 Host 是本复刻最重要的决定，但硬件采集仍然属于 Client。** 参考实现把语音服务和供应商运行时放在浏览器侧，导致 Host 侧的会话大脑无法直接调用它。新设计让 Host 持有全局协调、索引和动作桥，Client 通过 `VoiceRuntimeAdapter` 管理浏览器设备并把 PCM 送入同源流路由；控制、动作和状态通过 CodingNS RPC 连接两侧，不把 PCM 复制到 JSON 历史。

**关于 `realtimeVoice` 别名**：参考实现在 `client/client.js:914` 注册了这个别名，但它**既不在 README 中、也不在 `spec/runtime-contract.json` 中**。本 Spec 不把该别名纳入契约（它是参考实现的临时兼容别名）；若后续需要兼容已有消费方，再单独评估。

### 6.3 必须保真的部分

以下行为必须与参考实现一致，否则「复刻」不成立：

1. `registerActions` 对每个 action 校验 `execute` 必须是函数，否则抛 `TypeError`；`ownerPrefix` 为空、`actions` 非对象或是数组同样抛 `TypeError`。
2. `dispose()` 后该前缀的动作不再被匹配；`dispose()` 幂等，且只移除自己那一条。
3. `ownerId` 以 `ownerPrefix` 开头才匹配；同名前缀**后注册者优先**（参考实现用倒序遍历 + 覆盖写入实现）。
4. `ownerId` 为假值（`null`/`''`/`undefined`）时返回空动作表，即**静默不匹配**，不是报错。
5. 已匹配前缀下出现未注册动作名 → 返回 `{ ok: false, error: 'Unknown action: <name>' }`。
6. 参数校验失败 → 返回 `{ ok: false, error: 'Invalid action arguments.' }`。
7. `execute` 同步返回 → 直接结算；返回 `undefined` → 结算为 `{ ok: true }`；返回 Promise → 结算时解析（期间语音继续）；抛错 → 结算为 `{ ok: false, error }`。
8. 超时：默认 **300000ms**，`action.timeoutMs` 为正有限数时覆盖；计时器在调用 `execute` **之前**武装。
9. `control.resolve` 幂等，返回 boolean；已结算或句柄已关闭时返回 `false`。
10. 每次自动结算后发出 `action-result`，含 `callId`、`name`、`ok`、`output` / `error`；`output` 做**递归 4000 字符截断**（数组不截断）。
11. 动作的触发是**供应商工具调用**，没有自定义的 invoke 消息；分发由事件发出路径**自动**完成（参考实现称之为 dual output：同一事件既通知订阅者，也触发动作分发）。

> 第 5、6 条的错误文案逐字一致，是为了让对照测试可以直接断言字符串。

### 6.3.1 参考实现中**不应照搬**的部分

以下属于供应商特有的实现细节，本 Spec 不复刻（它们依赖具体云端协议的怪癖，照搬只会带来无意义的复杂度）：

- OpenAI 侧 VAD 打断**故意不发** `response.cancel`（重复取消会与服务端竞争并产生假错误）。
- 豆包侧工具结果**故意丢弃** `response.create`（该方言会自动续接）。
- 豆包的 `items[]` 工具信封格式、3500ms 空闲补时定时器、预览 PCM 提示音。
- 三条 basePath 的兼容循环、`agent-plan-speech` 与 `audio-artifacts` 相关能力。
- 浏览器 RMS 打断检测的具体阈值（`0.025` 地板、连续 4 帧、自适应系数）。

### 6.4 capabilities 诚实原则

`capabilities()` 必须返回**实际支持**的能力。Sherpa 运行时只有在包和模型成功加载后才报告实时能力；运行时不可用时只报告结构化不可用状态，不得调用 DSH `speechToText` 回退或把句级转写伪装成全双工。没有独立音频下行流时不得报告 `streamingAudio` 或 `streamingOutput` 为 true：

```ts
{
  secureContext: <按环境>,
  realtime: <运行时适配器探测结果>,
  recognition: true,
  audioInput: true,
  wakeWord: <运行时适配器探测结果>,
  bargeIn: <运行时适配器探测结果>,
  streamingAudio: <下行音频流与运行时适配器共同探测结果>,
  readAloud: <按 TTS 可用性>,
  voices: <按 TTS 可用性>,
}
```

`requirements.md` 需求 5 验收标准 2 明确禁止声称未实现的能力。

## 7. 全双工运行时与成熟开源实现

全局语音能力通过 `VoiceRuntimeAdapter` 接入按需加载的 `sherpa-onnx-node`。浏览器 Client 负责设备、权限和 PCM，Host 负责 Sherpa ASR、租约、索引和动作桥；适配器不能读取当前页面会话，也不能直接调用派发器。

连续音频帧走独立的 HTTPS 流路由，不进入 JSON RPC；原生包通过动态 import 加载，供应商协议和设备硬件细节停留在运行时适配器边界。

运行时必须满足以下行为：

- 音频输入由浏览器以带序号、可取消的流式 PCM 数据面传递，不能把连续对话降级成整段录音上传。控制面 RPC 与音频数据面必须分离，CodingNS 不能把每个音频帧复制进无界 JSON 历史。
- 播放和输入使用同一全局会话 epoch。`interrupt()` 后，旧 epoch 的播放帧和转写事件必须丢弃。
- 唤醒词只改变 standby/listening 状态。目标解析仍然依赖当前受管范围内的索引快照。
- 播放中检测到用户开口时先停止播放，再开始新的语音轮次；这就是 barge-in。
- Host/Profile 只允许一个麦克风租约；第二个标签页必须得到结构化的 busy 错误。租约必须绑定页面实例的唯一 owner ID，不能只记录 Host 进程。
- 浏览器设备权限拒绝、设备断开或来源不是安全上下文时，能力报告必须诚实，并保留普通文字输入；不能把失败的设备采集显示成已启动，也不能调用 DSH `ctx.speechToText` 回退。
- Client 负责监听 `devicechange` 和 MediaStreamTrack `ended`；适配器在设备断开或切换时递增 epoch，旧设备帧一律丢弃。
- 本地 TTS 第一版按句生成并可中断播放；只有增加真正的下行音频流和流式 TTS 后才能把输出能力报告为 streaming。

### 7.1 按需安装与模型生命周期

安装分为两个层级：

```text
核心 CodingNS 插件
  └─ 可选 voice-runtime-sherpa 包
       ├─ sherpa-onnx-node + 当前平台原生包
       └─ 用户选择的 ASR / VAD / KWS / TTS 模型
```

基础 Profile 不安装语音运行时。启用语音时，Host 按 `CODINGNS4DSH_VOICE_RUNTIME_PACKAGE` 动态解析包并准备 ASR、VAD、TTS 模型；包或模型缺失时只报告结构化能力缺失并保留普通文字输入。模型缓存必须包含版本、平台、语言和 SHA-256，下载使用临时文件，校验通过后原子改名。

### 7.1.1 模型状态与可用性验证

`AssistantVoiceModelManager` 分开保存文件事实、当前配置和验证结果。`assistant/voice/models` 对目录与当前自定义路径进行文件检查，返回缺失、不完整、已下载，以及文件大小、位置、当前模型和运行状态；查看状态不加载原生模型。

`assistant/voice/model/verify` 使用独立 Node 子进程加载 `sherpa-onnx-node`，复用正式运行时的识别器配置，输入两秒静音并检查解码和结果结构。默认 45 秒超时，模块释放时取消。进程隔离防止无效原生模型直接终止 Host；验证不使用麦克风，也不申请全局语音租约。

缓存的 `.validation.json` 记录验证状态、时间、错误与路径/大小/mtime/ctime 指纹；文件变化使旧结果失效。当前实现的指纹用于验证结果过期，不代替上文规划的官方 SHA-256 摘要校验，也不证明真实语音准确率或设备可用性。

初始化先准备文件、执行验证，再更新当前配置；重新下载在独立临时目录下载并验证，通过后整组替换缓存，替换失败恢复旧目录。Host 对下载、修复与验证串行处理，运行实时语音期间禁止切换与修复。新查询与验证同时登记主 RPC 通道和旧 HTTP 精确入口。

Client 使用可滚动的模型卡片，显示下载、当前配置、验证三个维度及折叠文件详情；提供刷新、验证、下载使用和重新下载。未知状态禁用操作，成功保持窗口展示结果。保留逐文件字节进度，原生验证单独显示不定进度；其他页面操作时自动刷新，卸载时清理查询与监听。

### 7.2 音频数据面

已有 `/codingns` JSON RPC 只负责 `start`、`stop`、`interrupt`、能力探测、状态事件和动作结果；连续 PCM 使用同源 HTTPS 流路由，不进入 CodingNS JSON RPC：

```text
浏览器 MediaDevices/AudioWorklet
  ↓ POST /api/codingns/assistant/voice/stream（JSON 行首部 + PCM16）
Host SherpaVoiceRuntime / GlobalVoiceCoordinator
  ↑ NDJSON partial / final / state / error 事件
assistant/voice/start|stop|interrupt 负责 Host 租约和控制
```

Sherpa 会话绑定 Host 租约和一个 epoch；断线、取消、generation 变化都必须释放识别流和播放队列。运行时不可用时返回结构化错误，不提供 `assistant/voice/transcribe` 回退。

成熟开源插件的复用限定在音频运行时。其页面按钮、供应商业务动作和当前会话绑定均不得直接复制；事件通过适配器归一化后再进入 CodingNS。

### 7.3 浏览器客户端设备管理

设备管理必须位于浏览器 Client，而不是 Host：

1. CodingNS Client 负责实时协议、PCM 管线和权限提示，在本地来源内枚举输入设备、保存选择，并把选中的 `deviceId` 注入 `getUserMedia()` 约束。设备 ID 不进入 Host RPC，也不复制供应商页面。
2. 设备偏好只保存 `deviceId` 的来源内引用和可读标签快照。浏览器可能在权限撤销、来源变化或设备重连后更换标识，因此每次启动都要重新枚举并验证，不能把失效 ID 当作永久硬件 ID。
3. CodingNS Client 负责 PCM 重采样、设备生命周期和流式发送；原始音频只进入独立 HTTPS 流，不进入 Host JSON RPC。
4. 局域网 Web 页面必须由 HTTPS/WSS 或浏览器认可的安全来源提供。HTTP 局域网地址不能通过 CodingNS RPC、iframe 或 Host 代理绕过浏览器的安全上下文限制。
5. 播放设备选择只对支持 `setSinkId()` 的本地音频元素生效。浏览器 `speechSynthesis` 使用浏览器/操作系统默认输出时，UI 必须显示“默认输出”，不得伪装成已选择指定设备。
6. Client 断开、刷新、权限撤销、设备拔出和语音停用都必须停止 MediaStreamTrack、断开 AudioWorklet、取消音频流，随后由 CodingNS 释放 Host 租约。

## 8. 测试策略

### 8.1 纯逻辑（无 DSH 依赖，重点覆盖）

- `assistant-intent`：各类意图识别、目标解析的精确/包含/序数/最近匹配、多候选必须澄清、**目标不在受管范围时必须澄清**。
- `assistant-summary`：优先级压缩、空类目必须说明、敏感字段过滤、播报文本不含 Markdown/URL。
- `assistant-scope`：范围为空时的提示、勾选与取消勾选的持久化、范围外目标被拒绝。
- `voice-agent` 动作注册表：`execute` 校验、`dispose` 语义、owner 前缀匹配、后注册者优先、未注册动作报错、超时结算、`action-result` 事件。

### 8.2 集成

- **范围过滤**：受管范围外的会话不出现在索引中；范围变化后索引立即重建；范围为空时提示而非报告"没有进展"。
- **归档过滤**：已归档会话不在索引中；归档一个在索引中的会话后它立即退出；取消归档后重新进入；摘要不含已归档会话；向已归档会话派发被拒绝。
- 索引构建：多工作区、含远端 Host 条目、含无标题会话。
- 摘要生成：单会话读取失败不影响整体；等待处理项来自审批/提问事件而非 `running`。
- 派发：`queue` 与 `steer` 选择正确；目标不存在时结构化错误；目标不唯一时澄清；空任务被拒；范围外目标被拒。
- 语音：转写为空不提交；浏览器设备枚举、选择、权限拒绝、设备断开、设备切换、租约冲突和安全上下文失败均有测试；麦克风被拒不影响键盘路径。

### 8.3 性能验证

- 索引构建耗时：受管范围内 89 个活跃会话应 **< 1.5 秒**（实测 1.03 秒）。
- 缓存命中时准备耗时 **< 100 毫秒**。
- 索引构建期间 DSH 会话处理不出现可感知延迟。
- 受管范围扩大时耗时与"范围内未归档会话数"成正比，与范围外会话数无关。

### 8.4 契约对照

- 逐条对照 `docs/20261004-voiceAgent服务契约调查.md` 中的契约面，确认方法名、事件名、owner 匹配规则、超时语义一致。
- 有意不一致处必须在文档中列出并说明理由。

### 8.5 回归

- 运行 `pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`。
- 完整 `pnpm test`，确认既有能力无语义变化。

## 9. 风险与未决问题

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Sherpa `OfflineTts` 不是流式 TTS | 无法直接提供 token 级下行音频 | 第一版使用浏览器 `speechSynthesis` 或按句生成的本地 VITS；只有独立下行流和流式 TTS 完成后才报告 streaming output |
| Runtime 包含原生二进制和模型 | 安装体积与平台兼容性增加 | 核心插件不捆绑；按平台动态安装，模型按能力下载并校验缓存 |
| Sherpa Node 包无 TypeScript 声明且以 CommonJS default 导出 | 静态导入会污染核心构建或在 ESM 下漏 API | 独立 Runtime 包提供类型外观，动态导入后使用 `module.default ?? module` |
| Sherpa 包或模型不可用 | 不能满足全局实时输入 | 能力探测失败时返回结构化不可用状态，保留普通文字输入，不能调用 DSH `speechToText` 或伪造全双工能力 |
| 当前测试机没有麦克风输入设备 | 无法完成真实采集和权限验收 | 浏览器 Stage0 设备测试；Host 侧 `node-cpal` 仅作可选后端 |
| Web 页面设备权限受浏览器来源限制 | HTTP 局域网地址无法可靠调用 `getUserMedia` | 通过 HTTPS/WSS 提供 Web 页面和数据面；检测 `isSecureContext`，失败时给出可操作提示 |
| 浏览器设备 ID 会因权限/来源/重连变化 | 保存的选择可能失效或误切到其他设备 | 每次启动重新枚举并验证，失效时要求用户重新选择；设备切换递增 epoch |
| 浏览器 `speechSynthesis` 不支持指定输出设备 | 用户以为播放已切换到指定扬声器 | 只对 `HTMLMediaElement.setSinkId()` 能力报告选择结果，`speechSynthesis` 明确显示默认输出 |
| 官方语音输入 bundle **可能未挂载** | 需求 4 的 `speechToText` 服务不可用 | 实测该 bundle 已在 profile 的 bundles 列表中，但 `cordis.patch.yml` 无对应条目 —— 任务 4.1 必须先确认或在 GUI 插件页启用 |
| 远端 Host 会话内容读取路径待确认 | 远端会话可能只能报标题 | 先按「远端只报标题与状态」降级，验证后再扩展 |
| 等待审批状态来源不统一 | 可能漏报待处理项 | 需求 7 验收标准 4 已强制要求独立来源；实测 `approval/asked` 事件存在 |
| `sherpa-onnx-node` 无项目级静态依赖 | 原生 addon 与平台绑定 | 使用动态 import 和本地最小类型外观；不把原生包静态导入 CodingNS 业务构建 |
| ~~`sessionQuery` 冷会话读取成本未知~~ | ~~摘要可能变慢~~ | ✅ **风险已关闭**：限定范围后实测 1.03 秒（见 §3.5） |
| 归档过滤需自行实现 | 可能漏掉归档判定，导致读入 454 个已归档会话 | `sessionQuery.filterSessions()` 无 archived 谓词（已核实）；必须在索引层用 `workspaceRegistry.archivedSessionIds` 过滤，并有专项测试 |
| 受管范围为空时行为未定义 | 用户可能看到"没有进展"的误导提示 | 需求 8 验收标准 7 已强制要求明确提示"尚未选择工作区" |
| 范围变更后的索引一致性 | 可能残留已移除工作区的会话 | 需求 8 验收标准 3 要求立即重建；测试覆盖勾选与取消勾选两个方向 |

## 10. 开放问题

1. 第一版默认播报走浏览器 `speechSynthesis`，还是在用户显式选择后下载本地 VITS？两者都不改变 Host 侧汇聚和派发。
2. 索引缓存放在 Host 内存还是持久化？限定范围后构建只需 1.03 秒，倾向于不持久化。
3. 远端 Host 的会话内容能否通过 spec006 的通道读取，还是只能拿到摘要级信息？
4. `readSurface()` 在最大会话（表层可能达数 MB）上是否需要二次截断？需实测后再定。
5. 受管范围是否需要在远端 Host 上单独配置？当前设计假设范围是本机全局的。
6. 归档会话是否需要"取消归档后自动重新纳入"之外的手动控制？当前设计是自动的。
7. Sherpa 运行时使用独立同源 PCM 流路由；控制面 JSON RPC 不承载连续音频。
8. 预置唤醒词的语言、音素文件和许可范围是什么？在未完成中文转音素前，不开放任意文本唤醒词。
9. Web 端的 HTTPS 证书由现有网关、反向代理还是用户自签发？在真实局域网设备验收前必须确定证书信任和 WSS 地址，否则浏览器麦克风权限无法通过。

# 设计文档 - 编程助理语音汇聚与实时对话

状态：Draft（阶段 1 已据实测回写）

## 1. 概述

### 1.1 目标

- 建立覆盖全部工作区与全部 Host 的会话索引，作为一切汇总与派发的事实来源。
- 用 DSH 核心已有能力完成语音输入，不引入新的识别依赖。
- 复刻 `voiceAgent` 服务契约，使语音对话能力归属 CodingNS 自己，不被第三方插件的发布节奏与供应商绑定牵制。
- 把「问进展」和「下指令」建模为两个已注册动作，意图路由只负责选择动作与抽取参数。
- 派发复用 `sessionController.prompt`，不新建第二条投递通道。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 7，以及全部非功能需求。

### 1.3 技术约束

- **不修改 DSH 核心**。只消费其公开服务。
- Host 侧可用的核心服务：`ctx.sessionQuery`、`ctx.sessionController`、`ctx.workspaceRegistry`、`ctx.llm`、`ctx.speechToText`。
- Client 侧可用的核心服务：`ctx.sessions`（`list` / `scope` / `refresh` / `open`）、`ctx.workspaces`、`ctx.conversation.input`、`ctx.uiSession`。
- 传输沿用现有 `cli/*` RPC 与 `llm/stream` 对话路由。
- 语音能力按 spec005 的 capability 边界挂载，不做散落的版本判断。

## 2. 架构

### 2.1 系统结构

```text
                     用户按住说话
                          │
                          ▼
              ┌───────────────────────┐
              │  语音输入（Client）    │
              │  MediaRecorder → PCM   │
              └───────────┬───────────┘
                          │ 16kHz 单声道 WAV
                          ▼
              ┌───────────────────────┐
              │  ctx.speechToText     │  ← DSH 核心，本地 SenseVoice
              │  （Host）             │
              └───────────┬───────────┘
                          │ 转写文本
                          ▼
              ┌───────────────────────┐
              │  意图路由（Host）      │  ← 本 Spec 新增
              │  汇总 / 派发 / 澄清    │
              └───────┬───────┬───────┘
                      │       │
        汇总意图      │       │      派发意图
                      ▼       ▼
        ┌──────────────────┐  ┌──────────────────────┐
        │  会话汇聚索引     │  │  派发器               │
        │  sessionQuery     │  │  sessionController    │
        │  + PeerHost 聚合  │  │  .prompt({sessionId}) │
        └────────┬─────────┘  └──────────┬───────────┘
                 │ 索引快照               │ queue / steer
                 ▼                       ▼
        ┌──────────────────┐  ┌──────────────────────┐
        │  摘要生成 ctx.llm │  │  目标会话（本机/远端） │
        └────────┬─────────┘  └──────────────────────┘
                 │ 摘要文本
                 ▼
        ┌──────────────────┐
        │  语音播报（TTS）  │
        └──────────────────┘
```

三层职责必须分开：**语音层只负责音频进出，汇聚层只负责事实，意图层只负责路由**。任何一层都不应该知道另外两层的实现细节。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `assistant-session-index.ts` | 构建并缓存会话索引 | `sessionQuery`、PeerHost 聚合 | `SessionIndexEntry[]` |
| `assistant-summary.ts` | 纯逻辑：把索引转成结构化摘要与播报文本 | 索引快照、可选会话内容 | 摘要对象、播报文本 |
| `assistant-dispatch.ts` | 目标解析与投递 | 目标描述、任务文本、索引 | 投递结果或澄清请求 |
| `assistant-intent.ts` | 纯逻辑：自然语言 → 意图 | 转写文本、索引 | `AssistantIntent` |
| `voice-agent-service.ts` | 复刻的 `voiceAgent` 服务 | 供应商适配、动作注册表 | 会话句柄、事件流 |
| `voice-agent-actions.ts` | 把汇总与派发注册为动作 | 上述模块 | 注册句柄 |

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
| 磁盘唯一会话 | 542 |
| **已归档会话** | **458（84.5%）** |
| **未归档（活跃）会话** | **90** |
| 归档会话磁盘占用 | 284.5 MB（**占 90.4%**） |
| 活跃会话磁盘占用 | 30.2 MB |
| 全量扫描耗时 | **6.49 秒** |
| **仅扫描活跃会话** | **0.91 秒** |

**仅索引未归档会话即可提速 7.1 倍、减少 86% 读取量。** 这同时解决两个问题：性能，以及"把几个月前结束的工作报成当前进展"的语义错误。

归档状态由 `ctx.workspaceRegistry` 的 `archivedSessionIds` 提供（实测本机 **458 条**）。

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
listSessions()                    ← 全集（542）
   │
   ├─ 按 workspaceRegistry 过滤受管工作区
   │
   ├─ 排除 archivedSessionIds       ← 剔除 458 个，剩 90 个
   │
   ▼
索引范围（实测 90 个活跃会话）
```

**为什么用 `listSessions()` 而不是只用 `workspaceRegistry`**：实测注册表只登记 483 个会话，磁盘有 542 个，**59 个游离在注册表之外**（`delegationDepth` 全为 0，不是子代理）。但受管范围生效后，这些游离会话只有在用户勾选了其 `cwd` 对应的工作区时才会被纳入 —— 游离会话不再是一个必须处理的问题，而是"工作区未勾选"的自然结果。

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

**`title` 允许为 `null`**。这是刻意的：实测 650 个会话中有 **43 个没有 `session/title` 事件**，把它填成 `sessionId` 会让摘要读出一串无意义 ID。

**`title` 必须取自会话日志中最后一条 `session/title` 事件**，不能取首条。原因是存在**暂态 HTML 标题**：实测有 6 个会话的首个 `session/title` 是 HTML 片段（形如 `<a class="btn btn-accent" href="...`），但末条已全部修正为正常标题。取首条会让播报读出一串标签，直接违反需求 3 验收标准 3。

`SessionHeader` 本身**不含 `title` 与 `workspaceId`**（已核实字段集为 `version`/`id`/`createdAt`/`cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth`/`agentPreset`），因此这两项都必须另行获取。

**注意**：因为索引范围已限定为受管工作区，`workspaceId` 不再是可空的（不再需要「未分组」兜底）。范围外的会话根本不会进入索引。

### 3.3 索引刷新策略

- 首次请求时全量构建。
- 后续通过 `ctx.on('session/event', ...)` 的 `turn/start`、`turn/end`、`user/message` 做增量更新。
- 摘要生成前如果索引超过 TTL（建议 30 秒），做一次轻量校验。
- **读取索引不得使冷会话变为 live**。`listSessions()` 本身不激活 Agent；`readSurface()` 只对需要摘要的会话调用，且限制数量。

**实测成本（本机 650 个会话 / 552,246 事件 / 334.8 MB 压缩数据）**：

| 操作 | 耗时 |
| --- | --- |
| 全量解压并扫描全部 650 个会话 | **4.59 秒** |
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
| 格式文件总数 | **650** |
| 唯一会话 ID 数 | **542** |
| 多格式并存的会话 | **47** |

按文件枚举会话会**重复计数 108 个**（650 vs 542）。核心的持久化层已做格式识别与去重，自行读盘必然踩这个坑。

### 3.4 等待处理状态的获取

这是本设计最容易出错的地方：**`SessionSummary` 上只有 `running` 和 `completed`，没有「等待审批」。** 如果直接用它，会把「等用户点审批」的会话报成「运行中」，用户就永远不知道该去处理。

正确来源：

- Host 侧：监听 `approval/request` 与 `user-questions/request` 事件。
- Client 侧：`ctx.uiSession.pendingInteractions`。

索引中 `waiting` 字段必须来自这两处之一，不得由 `running` 推断。

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
| 供应商 | 绑定 GPT Realtime / 豆包 Duplex | 适配器接口，第一版接本地 STT + PTT |
| 模型运行时 | 依赖 `dsh-multi-model-provider/realtimeModelRuntime` | **不依赖**，避免其版本漂移 |
| 动作匹配 | `ownerId.startsWith(ownerPrefix)` | 一致 |
| 超时语义 | 默认 300000ms，可按 action 覆盖 | 一致 |
| 事件名 | 9 种归一化事件（含未在契约文件声明的 `interrupted`） | 一致，并在契约中**完整声明** |
| 错误文案 | `'Unknown action: <name>'`、`'Invalid action arguments.'` | 一致（便于对照测试） |

**注册位置从 Client 改到 Host 是本复刻最重要的决定。** 参考实现把服务放在浏览器侧，导致 Host 侧的会话大脑无法直接调用它，必须自建 host↔client RPC 桥。而汇聚与派发所需的 `sessionQuery`、`sessionController` 都在 Host 进程内，把语音服务也放 Host 侧可以省掉这座桥。

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

`capabilities()` 必须返回**实际支持**的能力。第一版：

```ts
{
  secureContext: <按环境>,
  realtime: false,        // 第一版不是云端实时会话
  recognition: true,
  audioInput: true,
  readAloud: <按 TTS 可用性>,
  voices: <按 TTS 可用性>,
}
```

`requirements.md` 需求 5 验收标准 2 明确禁止声称未实现的能力。

## 7. 为什么第一版不做 barge-in

这是本设计最重要的取舍，理由是成本结构：

`dsh-voice-mode` 有 **33 个测试文件，其中 11 个是音频正确性**（`aec`、`barge-in-manual`、`barge-in-detect`、`endpoint`、`endpoint-short`、`resample`、`tts-playback`、`segmenter`、`wakeword`、`wake-standby`、`wake-flow`）。这份清单本身就是成本估算：**开口打断的难点不是调用识别接口，而是回声消除、播放队列正确性和端点检测。**

因此第一版：

- 输入用按住说话（PTT），用户手势明确开始与结束，不需要端点检测。
- 播报期间不监听麦克风，不需要回声消除。
- 用户想打断时松开/按下按钮即可，交互语义清晰。

**这不影响需求 1 至需求 7 的任何验收标准**，因为那些需求关心的是「说得出、听得懂、派得准」，而不是「能不能抢话」。barge-in 作为后续增强，届时以 `dsh-voice-mode` 的音频处理作为参考（MIT 许可，可读）。

## 8. 测试策略

### 8.1 纯逻辑（无 DSH 依赖，重点覆盖）

- `assistant-intent`：各类意图识别、目标解析的精确/包含/序数/最近匹配、多候选必须澄清。
- `assistant-summary`：优先级压缩、空类目必须说明、敏感字段过滤、播报文本不含 Markdown/URL。
- `voice-agent` 动作注册表：`execute` 校验、`dispose` 语义、owner 前缀匹配、后注册者优先、未注册动作报错、超时结算、`action-result` 事件。

### 8.2 集成

- 索引构建：本机多工作区、含远端 Host 条目、含无标题会话。
- 摘要生成：单会话读取失败不影响整体；等待处理项来自审批/提问事件而非 `running`。
- 派发：`queue` 与 `steer` 选择正确；目标不存在时结构化错误；目标不唯一时澄清；空任务被拒。
- 语音：转写为空不提交；麦克风被拒不影响键盘路径。

### 8.3 契约对照

- 逐条对照 `docs/20261004-voiceAgent服务契约调查.md` 中的契约面，确认方法名、事件名、owner 匹配规则、超时语义一致。
- 有意不一致处必须在文档中列出并说明理由。

### 8.4 回归

- 运行 `pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`。
- 完整 `pnpm test`，确认既有能力无语义变化。

## 9. 风险与未决问题

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| TTS 不在 DSH 核心 | 播报需自选实现 | 第一版可用浏览器 `speechSynthesis` 兜底；后续接本地 VITS/Kokoro |
| 官方语音输入 bundle **可能未挂载** | 需求 4 的 `speechToText` 服务不可用 | 实测该 bundle 已在 profile 的 bundles 列表中，但 `cordis.patch.yml` 无对应条目 —— 任务 4.1 必须先确认或在 GUI 插件页启用 |
| 远端 Host 会话内容读取路径待确认 | 远端会话可能只能报标题 | 先按「远端只报标题与状态」降级，验证后再扩展 |
| 等待审批状态来源不统一 | 可能漏报待处理项 | 需求 7 验收标准 4 已强制要求独立来源；实测 `approval/asked` 事件存在 |
| `dsh-realtime-voice` 无 `.d.ts` | 契约来自实现而非类型 | 已在调查文档中标注，复刻以 `runtime-contract.json` v8 + 代码为准 |
| ~~`sessionQuery` 冷会话读取成本未知~~ | ~~摘要可能变慢~~ | ✅ **风险已关闭**：实测全量 650 会话 / 552,246 事件仅需 4.59 秒 |

## 10. 开放问题

1. 语音播报走浏览器 `speechSynthesis` 还是本地 VITS？前者零依赖但音色一般，后者需要模型下载。
2. 索引缓存放在 Host 内存还是持久化？全量读取实测 4.6 秒，刷新后重建的成本可接受，倾向于不持久化。
3. 远端 Host 的会话内容能否通过 spec006 的通道读取，还是只能拿到摘要级信息？
4. `readSurface()` 在最大会话（表层可能达数 MB）上是否需要二次截断？需实测后再定。

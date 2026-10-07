# 设计文档 - 编程助理语音汇聚与实时对话

## 20261007 扩展：实时语音延迟与完整字幕

- `AssistantTtsService.beginVoiceSession` 在有效租约建立后开始安装验证及异步模型预热；服务共享 Worker 创建 Promise（异步任务），`MossTtsWorker.prepare` 与首句共享启动 Promise，不占用串行推理名额。失去租约撤销预热，保留既有空闲释放规则。
- 安装验证缓存限定持有页面和活动通话；Client 播报传入 `ownerId`。独立试听、新通话、失败及重置不复用旧验证。
- `AssistantTextChat.subscribe` 提供累计文字和终态，`AssistantVoiceChat.subscribe` 过滤页面与请求所属代次。语音 GET 下行增加 `chat` 消息，首部声明推送支持；Host 再次校验当前租约。背压时保留一个最新完整快照，工具明细不随文字重复传输。
- Client `VoiceChatUpdates` 每轮保存一个最新快照，处理推送早于 RPC 返回；推送立即驱动字幕和短语队列，700 ms 无更新才降级读取，旧 Host 仍采用 250 ms 轮询。请求与代次隔离沿用原有打断语义。
- Sherpa 有语音句尾静音默认 0.8 秒，环境参数允许 0.6～2.4 秒并可恢复 1.2 秒；空白句尾和最长话语规则保持原样。
- 通话字幕移除段落一到两行裁切，统一滚动区域保留完整当前回复；默认跟随末尾，手动回看暂停跟随，新轮次重置。诊断增加预热、安装验证复用、推送与回退指标，仍不记录正文和音频。

## 20261007 扩展：管理 Agent 与逐句流式播报

本节覆盖下文历史版本中“正式对话只读、不调用工具、整段完成才播报”的约束，生命周期及共享持久交流记录沿用 spec013.1。

- `assistant.agent` 由能力路由集中探测，当前支持 DSH 0.2.1-alpha.1。`AssistantAgentAdapter` 位于兼容边界，用同一 Host 的原生创建接口维护根 Agent，省略 parentAgent；首次说话才准备独立空工作目录。采用会话级只读沙箱，不变更部署配置。
- 创建 setup 注册 complete 系统提示词、抑制继承的动态编程上下文、声明 native 工具模式、屏蔽所有继承工具、注册四个管理工具并安装执行白名单。原生工具参数只使用当前 DSH 支持的 JSON Schema 子集。其他 Agent 不受这些作用域声明影响。
- 模型每步固定为助理选择，单请求最多 1024 输出 token（模型文本单位），仅助理使用 off／none。一轮最多八步和十二次管理工具调用，90 秒轮次超时沿用现有文本轮次服务。自然交流默认一到两个短句、100 字以内。
- `AssistantConversation` 继续持有交流记录。连续完成问答复用运行实例；最多九轮后从近期记录重建，模型变化、压缩、清理、范围隔离或失败造成历史不匹配时也重建。Host 重启从现有持久记录恢复交流，重新建立受限运行实例，不把旧运行实例作为项目会话恢复。助理原生会话 ID 使用专有前缀，不参与项目索引。
- 管理工具每次读取当前范围和原生成员。读取后再次核对范围及更新时间；跟进在发送前检查完整来源元组、范围、归档状态、索引代次和更新时间。复用 Dispatcher，默认 queue（排队），执行 ID 去重；本地和远端均转发取消信号。accepted 仅表示消息送达，不代表目标完成。
- 当前有效索引用于历史进展分析，管理工具最新来源状态优先。项目索引仍保持完整轮次结束后五秒合并更新；查询工具不启动目标会话，用户要求的管理跟进才会通过原生 prompt 入口唤醒或排队目标。
- Agent 流事件只投影 text-delta／text block；思考块和工具参数／结果不投影。原生驱动空闲且最后模型正常结束才结算问答；失败和撤销不进入完成历史。
- Client `StreamingSentenceQueue` 按中文句尾标点、英文句点加空白及换行分句，小数和网址不拆分。完整句子立即入队，最多 32 个待播句子，流正常结束时补齐残片；音频串行生成，模型推送或兼容轮询并行继续，重复累计快照不重复入队。MOSS 每句复用已有流式 PCM 接口，浏览器每句使用独立 utterance（播报任务）；完整结束后才恢复监听状态。
- 生成、语音租约、请求 ID 和 Client 取消信号共同控制新旧请求；停止或新话语使队列失效并取消正在播放的音频。TTS 失败明确透传，不默默切换后端或转写服务。

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
| `ctx.sessionController.list()` | 当前原生会话投影 | 提供 `blank/origin/running/updatedAt`；读取不启动 Agent，空列表或失败不得回退全量历史 |
| `ctx.sessionQuery.listSessions()` | 缺少原生列表能力时的兼容来源 | 返回 `{ header, live, persisted }` 包装对象；仍必须执行成员与可见性过滤 |
| `ctx.workspaceRegistry` | **受管范围**、工作区归属、**归档集合** | 只读；提供 `archivedSessionIds` 与工作区列表 |
| `ctx.sessionQuery.readTitleSnapshots(ids)` | 批量标题 | 比逐会话读取便宜 |
| `ctx.sessionQuery.readSurface(id)` | 生成摘要所需的会话内容 | **已过滤为模型表层**，避开流式 chunk |
| PeerHost 聚合（spec006） | 远端 Host 的会话 | 复用既有通道，不新建 |

**过滤顺序**（每一步都缩小后续工作量）：

```text
sessionController.list()          ← 原生会话投影
   │
   ├─ 按 workspaceRegistry.sessionIds 确认成员并过滤受管工作区
   │
   ├─ 排除 origin=subagent、blank=true
   │
   ├─ 排除全局 archivedSessionIds
   │
   ▼
索引范围（Stage0 TEST 对照为2个普通未归档会话）
```

**成员口径修正（2026-10-07）**：历史日志存在且 `cwd` 相同，不意味着会话属于工作区；子代理和空白占位也会保留日志。此前按目录纳入游离会话的规则取消。本地成员以工作区注册表为准，再使用原生投影排除子代理和空白占位；普通独立分叉不因父会话归档而被排除。归档记录只保留无正文的诊断元数据，刷新发现成员变化时旧正文索引标记过期。

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

- Host 启用后为已确认空闲的范围内会话建立初始索引；运行、等待或执行状态未知的成员延后处理。
- 后续按 Host/会话记录版本，通过原生语义事件标记变化；只在一轮执行结束后合并更新，复用其他会话材料和校验结果，详见 §7.6。
- 每5秒读取元数据发现远端或遗漏的版本变化，轮询本身不读取索引正文、不调用模型。
- **读取索引不得使冷会话变为 live**。`listSessions()` 本身不激活 Agent；`readSurface()` 只对需要摘要的会话调用，且限制数量。

**实测成本（本机 594 个格式文件 / 552,246 事件 / 334.8 MB 压缩数据）**：

| 操作 | 耗时 |
| --- | --- |
| 全量解压并扫描全部 594 个格式文件 | **6.56 秒** |
| 解压单个最大会话（5.38 MB → 13.0 MB / 19,921 事件） | **0.118 秒** |

以上是早期日志扫描成本，不包含后续 LLM 结构化索引。当前以逐会话增量更新避免重复正文读取与模型请求，不根据扫描耗时推断模型调用成本。

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

2026-10-07 的中文首选模型为 Zipformer Large（2025-06-30），模型 ID 为 `sherpa-onnx-streaming-zh-large-2025-06-30`。该发布包使用 `encoder.int8.onnx`、浮点 `decoder.onnx`、`joiner.int8.onnx` 和 `tokens.txt`，不能套用旧 14M 模型的文件名。目录新增推荐项但保留旧 ID，其他用户已有选择不自动迁移；本轮按用户要求仅切换 Stage0 专用配置，并保留原模型缓存。

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
  ↓ POST /api/codingns/assistant/voice/stream?mode=frames（短批次 JSON 行首部 + PCM16）
Host SherpaVoiceRuntime / GlobalVoiceCoordinator
  ↑ GET /api/codingns/assistant/voice/events?ownerId=...（持续 NDJSON 事件）
assistant/voice/start|stop|interrupt 负责 Host 租约和控制
```

浏览器默认使用有限二进制 POST，不将 `ReadableStream` 放进请求正文，也不依赖 `duplex: half`。采集器的小帧每 60 ms 合并上传，上一批请求结束后才发送下一批；Host 沿用同一个 Sherpa 识别流，不按批次重建识别器。上传积压最多 128 KiB、单请求最多 5 秒，超限或失败时停止采集并释放租约，不丢帧后假装仍在实时识别。

事件下行与上传独立，先校验 owner 租约，再立即发送状态和 Host epoch。反向代理响应关闭缓冲，静音期间每 10 秒发送空行维持连接；停止、取消或租约失效时释放全部订阅。下行断开不能留下仍在上传的麦克风。动作处理和语音播报异步执行，不阻塞下一条 partial。

DSH 原生 HTTP 桥按路由决定请求正文读取方式。事件 GET 单独登记在 `/events`，使用 `requestBody: buffered`；PCM POST 继续登记在 `/stream`，使用 `requestBody: streaming`。两种方法不能共用 streaming 配置，否则原生桥会给 GET 附加正文，Node 在进入语音处理器前就抛错，WebServer 返回空正文 HTTP 400。buffered 只约束 GET 请求读取，不影响 NDJSON 响应持续下发。

控制面打断只调用一次 RPC，并按返回的 Host epoch 继续上传；旧代次的音频由 Host 丢弃。旧客户端的单 POST 流入口暂时保留，新客户端不再使用。

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

### 7.4 独立全局助理管理调试

助理图标始终先打开窗口，配置和调试作为显式按钮。调试模态框与语音窗口分开；从正在对话的窗口进入时先停止当前语音，退出调试后不自动重启。调试组件只读设置、原生工作区列表和助理 RPC（远程过程调用），不创建音频流或申请租约。

| 接口 | 用途 | 操作边界 |
| --- | --- | --- |
| `assistant/debug` | 当前范围成员、上次索引、索引新鲜度、运行记录与诊断 | 只读元数据，不触发正文索引 |
| `assistant/index/configure` | 更新后台索引使用的模型 | 模型变化使缓存失效，运行会话仍等待完成 |
| `assistant/index/rebuild` | 手动读取当前范围正文并后台生成 LLM 进展总结 | 可选 `provider/model`；原始材料与总结独立；范围外及归档正文不读取 |
| `assistant/index/cancel` | 停止当前模型总结 | 根据请求 ID 校验，不删除来源索引 |
| `assistant/chat/models` | DSH 原生模型目录及默认选择 | 复用宿主模型与凭据 |
| `assistant/chat/start` | 基于指定索引版本启动只读 LLM 问答 | 复核模型、范围、索引新鲜度和消息历史 |
| `assistant/chat/read` / `assistant/chat/cancel` | 读取增量文字或停止生成 | 同一请求 ID 不重复启动模型；模块停用时取消 |
| `assistant/preview` / `assistant/turn` | 保留既有规则意图预览与执行契约 | 新调试面板不再把它们当作 LLM 对话 |

数据源保留全部可映射会话的标题与范围元数据，统一由索引构建器过滤；只对受管且未归档的本地会话读取额外标题和正文。归档 ID 不在会话列表中时生成无正文占位。远端记录使用 Gateway（网关）已有元数据，不重复查询本地正文。调试页显示范围外、归档、归属不明和读取失败诊断，未知状态保持未知；服务标记只说明接口已接入，不冒充连接健康检查。

五个标签分别展示范围设置、范围内工作区/会话、当前索引、索引记录和 LLM 问答。管理范围通过既有设置 Store（状态存储）立即持久化；成员列表不依赖已建索引，空工作区也显示。JSON、服务接入和排除记录放入折叠区，窄屏按钮换行、内容纵向滚动。

`AssistantIndexJournal` 分别维护上次完成的快照与最近 30 次运行记录，刷新缓存只标记过期，不删除证据。记录包含每个会话的正文读取结果及脱敏错误，不保存正文。索引代次独立于缓存维护；构建开始时捕获源数据修订，构建期间收到失效事件时，完成结果仍保留但标记过期。范围改变后仅返回新范围元数据，旧正文不返回。

正文使用 `sessionQuery.readSurface` 的 v4 语义事件，真实用户来自 `source.kind=user`，助理正文来自 `data.message.content`；跳过上下文注入与 reasoning（内部思考）块。运行状态使用本地 `sessionController.list`/Agent 的真实状态，`live` 仅表示内存实例存在。没有可靠状态时保留 unknown，汇总显式包含这些会话。

原生模型入口集中在 `llm.text` 能力适配器，本次只启用已验证的 DSH 0.2.1-alpha.1 契约：`listProviders`、`listModels`、`stream`。使用 `agentDefaultModel.currentSelection` 作为默认选择；没有原生模型的外部 CLI 提供商不进入列表。消息按 v4 构造，用户消息使用无身份输入，助理历史带模型来源；增量按块索引合并，`block-end` 不重复正文，必须检查终止 `finish` 的错误或中止原因。

`AssistantTextChat` 只把受管索引事实交给 LLM，不传排除会话、不创建 Agent/项目会话、不提供工具。当前索引优先于历史，未知状态和空正文不能被编造成结论。单次最多 20 条历史、每条 8000 字符，事实材料最多 120000 字符；模型输出最多 2048 token，90 秒中止，轮次保留最多 30 条。Client 每 600 毫秒读取文字；关闭或停止取消模型请求。范围、模型或索引版本变化后清空文字上下文。所有新增动作同时登记主 RPC 通道和旧 HTTP 精确入口。

语音动作仍沿用已有规则解析与派发检查；此次只改变独立文字调试路径，不补全或重设计正式语音助理消息界面。

### 7.5 结构化索引与口语提示词（2026-10-07）

调试面板共用一个索引/对话模型选择。索引先保存原始摘录，再由 `AssistantIndexAnalysis` 建立每个会话独立的模型任务，不复用文字聊天的30轮容量限制。每个请求只接收对应会话材料，独立分配8192 token输出预算、取消信号与90秒超时，最多两个任务并发；目录读取阶段也有90秒上限。RPC 立即返回运行状态，Client 通过 `assistant/debug` 轮询，停止使用 `assistant/index/cancel`。会话结束后后台自动增量更新；刷新面板只读取元数据，不直接调用模型。文字对话仍为2048 token；断流或长度不足明确失败，不截断为成功结果。

`AssistantIndexSnapshot.analysis.result` 汇聚各任务通过校验的结构化结果：固定版本、索引代次和逐会话目标、进展、阻碍、待办、下一步行动、信息缺口。运行中或失败时也保留成功项，整批只有全部任务成功才标记完成。事实和行动均附同一会话的证据引用；行动区分已有任务与建议，并保留优先级和理由。身份、工作区、更新时间、来源运行状态和材料可用性由 Host 填入，模型不能覆盖。`entries[].summary` 保留来源，`analysis.tasks` 保存独立任务的身份、状态、时间、错误、思考参数状态和未校验增量；运行记录排除增量与结果正文，只保留任务元数据。

索引任务调用原生 `llm.resolveModelInfo(provider, model, signal)` 读取模型能力：存在 `off` 或 `none` 档位时传入对应的 `reasoningEffort`，否则保留供应商默认参数，并在调试页明确说明。DSH 0.2.1-alpha.1 的 DeepSeek 适配器会将 `off` 序列化成 `thinking: { type: "disabled" }`，关闭时不发送 `output_config.effort`。能力读取失败使对应任务失败，不假装已经关闭；普通聊天不传索引专用参数。该参数解决思考开销，不能代替逐会话输出隔离，也不保证请求必然更快。

`assistant-structured-index` 对每个任务严格校验 JSON 键、类型、唯一会话覆盖、重复与范围外会话、各字段上限及原文引用。除目标外，事实与行动必须引用正文。目标无法确认或正文缺失时必须记录信息缺口。校验在任务完成前执行，非法结果只使该项失败，其余任务继续；调试页保留成功项并标记整批 `incomplete`，问答拒绝继续。未校验 JSON 只在对应会话的诊断折叠区显示，不当成索引。证据存在只证明出处，不等于独立验证语义结论。

LLM 文字问答使用已校验的 `analysis.result`，按 Host/会话定位、按工作区分组，区分历史工作进展与当前运行状态、已有任务与新建议。与来源材料冲突时以来源为准。`assistant/summary` 从校验后的字段生成简短播报，绝不朗读内部 JSON。

两套前置提示词持久化在 `assistant.prompts.index/chat`，单项最多8000字符，旧配置和清空值使用默认。索引前置提示词要求具体、简短的字段表达，固定结构优先于旧提示词中的整段播报和句数要求；对话默认一到两个短句、100字以内，先给结论和必要的处理动作，不使用标题、编号、列表、表格、Markdown、排比或重复铺陈，用户明确要求详细或全部时再展开。Host 始终追加只读、来源隔离、未知状态、证据不足和建议标识约束。

修改索引提示词停止当前总结并使结果过期，自动重建时仍遵守会话完成门禁。修改对话提示词停止旧回复并清空 Client 历史，不使来源索引失效。范围变化取消仍在生成的总结并隐藏旧材料；关闭调试页只取消文字对话，自动索引后台任务继续，模块释放取消全部模型轮次。来源提取仍为最近80条语义事件的有界摘录，模型无法据此声称完整项目审计。

### 7.6 会话完成后的自动增量索引（2026-10-07）

`AssistantIndexUpdates` 以 `[hostId, sessionId]` 为键保存来源版本、已索引版本、已尝试版本、语义事件序号与执行状态。范围外、归档、子代理和空白占位不进入版本表。来源标题或更新时间变化、真实用户消息、助理消息、工具记录、待办、压缩摘要及运行边沿只推进对应成员版本；事件序号去重，不处理流式片段或运行时上下文消息。

执行状态与项目进展分开：原生 `agent/status` 的 `running → idle`、外部 `api-session/status` 的结束通知或明确完成通知才允许索引。`turn/end` 只提示需要检查，仍需确认执行结束；`step/end` 和日志刷新不能放行。运行、等待或状态未知的任务标为 `deferred`，不读取新正文、不调用模型，手动索引也遵守此门禁。自动更新延迟5秒合并多个结束通知，有效变化重新计时，普通刷新、无变化轮询、日志刷新和重复空闲通知不延长已有计时；任务生成前、能力读取后及结果写入前再次检查版本。若该会话开启新轮次，只中止该项，迟到结果不写入缓存。

正文缓存绑定来源版本；模型缓存用模型提供商、模型、索引前置提示词、固定格式、标题与实际摘录的 SHA-256（内容摘要）识别。仅一条会话变化时重新提取该会话材料；材料未变直接复用校验结果并推进已索引版本。工作区增删、归档与取消归档只改变对应成员，共同成员缓存保留。模型、索引提示词或格式变化让所有成员重新生成，但运行成员仍延后。同一版本的失败结果保留，不随轮询或其他会话更新自动重试；手动执行可重试，来源新版本也可再次尝试。

远端每5秒只查询元数据。导航投影默认的 `idle` 不能证明执行完成，独立 `activity` 保留 `unknown`；真实模型请求前重新读取远端执行状态与更新时间，发现运行或版本变化就延后。没有可靠空闲证明时等待，不能为了自动索引猜测完成。

自动更新不依赖调试窗口；窗口仅持续显示版本、复用、失败和等待进度。全部成员覆盖且版本当前时才允许文字问答。缓存和运行记录属于当前 Host 内存，重启后重新建立初始索引；增量单位是会话，变化会话重新读取当前有界摘录，不是逐消息追加完整历史。

### 7.7 对话回复长度与重点（2026-10-07）

仅要求“简短口语”仍会产生长段落，因此默认对话前置提示词增加句数、总长度和每句一个重点的约束。Host 在事实材料后追加回复规则，明确先回答当前问题，再提供必要动作；不照搬历史长回复，不主动补背景、其他会话或附加建议。询问需要用户处理的会话时，优先筛选需要审批、回答、确认或用户介入的阻碍，区分普通助理待办和模型建议。未知状态与证据不足仍参与事实判断，仅在影响当前答案时简短说明，不固定追加整批状态声明。

`readAssistantPrompts` 只把完整匹配的旧版默认对话文本替换为新默认值，不写入原配置对象，真正自定义提示词保留。调试编辑器和 Host 共用读取器；索引提示词、格式与缓存识别保持原有逻辑，因此不为回复表达重建索引。100字是模型生成要求，不通过本地裁剪截断句子；输出预算保持2048 token，让用户追问细节时仍可完整回答。实际生成质量需要真实模型联调验证。

## 8. 测试策略

### 8.1 纯逻辑（无 DSH 依赖，重点覆盖）

- `assistant-intent`：各类意图识别、目标解析的精确/包含/序数/最近匹配、多候选必须澄清、**目标不在受管范围时必须澄清**。
- `assistant-summary`：优先级压缩、空类目必须说明、敏感字段过滤、播报文本不含 Markdown/URL。
- `assistant-scope`：范围为空时的提示、勾选与取消勾选的持久化、范围外目标被拒绝。
- `voice-agent` 动作注册表：`execute` 校验、`dispose` 语义、owner 前缀匹配、后注册者优先、未注册动作报错、超时结算、`action-result` 事件。

### 8.2 集成

- **范围过滤**：受管范围外的会话不出现在索引中；范围变化后缓存立即失效，调试通过按钮重建，语音动作按需重建；范围为空时提示而非报告"没有进展"。
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
# 20261007 扩展设计：实时语音 LLM 多轮对话

## 实时语音复用 LLM 多轮问答（20261007）

最终识别话语经 `voice/chat/start` 建立后台轮次，Client 每250毫秒通过 `voice/chat/read` 获取累计正文，按请求标识更新同一条助理消息；PCM 采集和识别事件连接保持独立。完成正文交给现有 MOSS 或浏览器播报，不朗读内部索引 JSON。语音状态新增思考态，播报后恢复聆听；清空会同步取消生成和音频并清除 Host 历史。

此处最初使用租约内最多九对历史。现由 spec013.1 的 `AssistantConversation` 持有共享持久记录；停止语音、租约失效和索引更新保留已完成问答。正式文字和语音共用模型选择、近期九对交流及压缩摘要；范围变化隔离旧范围上下文，清理和完整重置才删除助理记录。20261007 管理 Agent 扩展进一步替换直接 LLM 执行引擎，允许在索引未就绪时通过受限管理工具查询当前项目。

租约 owner、epoch、请求 ID 和递增话语顺序共同隔离迟到结果；保留有界撤销标记，取消先于启动到达时也不允许重新启动。模型目录等待期间可撤销；生成取消或90秒超时立即结算，不依赖上游处理 Abort 的速度。Client 另有每轮取消信号和身份核对，相同 epoch 的旧回复也不能覆盖新话语或播报。所有语音问答入口按租约校验，新增控制接口同时登记旧 HTTP 精确路由。

旧 `voice/text` 接口保留参数和可播报返回值，但内部也进入 LLM。显式文字派发与动作桥注册继续兼容；实时识别话语不再走关键词动作。索引门禁失败时只提示等待自动索引或手动重试，不强制索引运行中的会话，不添加转写服务回退。

# 20261007 扩展设计：Host MOSS TTS 与独立音色管理

- 设置：`assistant.tts` 保存输出后端、所选音色与导入记录，独立于 ASR 模型及形象包；旧配置补默认浏览器后端，避免破坏已通的语音链路。
- 音色：统一记录 `id/name/language/gender/source/license/reference`。内置声音以官方 `voice` ID 查 manifest 预编码；外部参考录音由 Host 缓存并由 ONNX codec 编码，不能把 Kyutai 自用嵌入交给 MOSS。
- 试听：官方包未公开全部预设的原始 WAV，内置参考试听用 codec 解码清单中的预编码；外部音色试听下载后的录音。合成试听和实际播报共用同一推理入口、音色 ID 与流式播放器。
- 网站：Kyutai 官方 TTS 页可列出和试听，导入采用 `kyutai:<目录>/<录音>.wav` 或 Hugging Face 文件链接；中文使用 AISHELL-3 数据浏览页，导入精确录音 ID 或文件链接。Host 使用固定来源解析器，不爬取任意网页。
- 资源：模型、codec、SentencePiece 和官方 NumPy／ONNX 核心版本固定；Python 工作进程使用 `onnxruntime/numpy/sentencepiece/soundfile/scipy`，不加载 PyTorch。工作进程按需启动、串行推理，停止与超时终止旧任务；空闲后释放模型内存。
- 数据面：现有语音路由增加 TTS 下行和录音试听入口，控制和元数据留在 RPC；音频不经 JSON RPC。Client 使用可取消的流式 PCM 播放器，切换设备和停止会释放播放资源。
- 边界：实现位于现有全局助理模块，复用资源作用域、设置服务和原生路由认证。用户必须在面板点击初始化才安装专用 Python 环境和模型；本轮仅修改仓库并运行无构建验证。
- 精细播报：`assistant.tts.parameters` 保存语速、音量、分段停顿、token 预算与种子。`tts/configure` 严格校验并保存，临时合成试听可传覆盖值，不写设置。播放层使用 playbackRate 与 GainNode，分块按 `duration / rate` 衔接；浏览器后端使用 utterance.rate／volume。生成层按预算分段、仅在段间追加静音，每次请求重置独立 RNG（随机数生成器）。默认语速与音量均为 1，停顿 0，预算 75，种子自动随机。

## 声音首次配置向导（20261007）

- Client：`AssistantVoiceInitializationPanel` 装配最新声音管理页，初次只显示推荐值与启用按钮；高级内容延迟挂载，完成后恢复独立音色、播报参数及设备管理。外层草稿音色选择移除，Host RPC 写入后重读权威设置。
- Host：`AssistantVoiceInitialization` 汇聚现有识别模型验证与 TTS 快照，不增加第二份模型配置。`voice/initialization` 查询进度，`voice/initialize` 按序准备缺失组件，复用已有可用组件。新增端点同步登记旧 HTTP 精确路由。
- 默认策略：未配置时取中英双语实时模型；已有模型 ID 继续使用，手工路径缺少 ID 时要求用户确认高级模型选择。播报初始化沿用原音色与参数，仅在全部准备完成后使用 MOSS。
- 环境：CPython 3.12.12／python-build-standalone 20251014 固定平台资源与 SHA-256 摘要；专用目录管理解释器、虚拟环境和 pip 缓存，保留原有可运行环境和显式覆盖。二进制依赖版本固定，不向系统 Python 安装库。
- 失败与取消：普通网络失败跳过已完成文件，图验证失败才触发模型重新下载；安装任务使用参数数组启动，取消后等待子进程关闭。向导任务纳入现有模型任务集合，完整重置先撤销并等待，再清空配置。真实安装及资源占用保持设备验收边界。

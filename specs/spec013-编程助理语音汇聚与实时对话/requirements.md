# 需求文档 - 编程助理语音汇聚与实时对话

状态：Draft（阶段 1 已据实测回写）

## 简介

CodingNS 的会话已经分布在多个工作区，还可能分布在多个 Host 上。用户当前的处境是：

- **想了解进展，必须逐个点开**。spec006 把远端工作区会话聚合进了同一个列表，但「看」这件事仍然需要人一个个点开、读、再自己拼起来。会话数量一多，这件事就不成立了。
- **想推动某个任务，必须切过去手动输入**。用户已经知道该让哪个会话做什么，但操作路径是「找到那个会话 → 点进去 → 打字 → 回车」。开车、走动、手上有事的时候，这条路走不通。

本需求要解决的是：**用说话的方式问进展、下指令**。

目标用户就是 CodingNS 的日常使用者，也就是同时推进多个工作区、多个 Agent 会话的人。成功后的核心收益是：不用盯着屏幕就能知道「现在什么在跑、什么卡住了、什么刚做完」，并且能直接说一句「让终端那个会话先跑测试」就完成派发。

## 术语表

- **System**：CodingNS for DeepSeek Harness 插件及其 DSH Host/Client 运行时。
- **工作区**：DSH 的工作区（workspace），一个工作区下有多个会话。
- **受管工作区范围**：用户**手动勾选**的、允许智能助理索引与操作的工作区集合。范围之外的工作区不被读取，也不出现在摘要中。
- **归档会话**：被用户归档的会话，由 `ctx.workspaceRegistry` 的 `archivedSessionIds` 标识。归档会话**只保留历史记录**，不进入索引、不参与摘要、不接收派发。
- **会话索引**：把**受管工作区范围内、未归档**的会话整理成一份可查询的快照，包含标题、状态、所属工作区、最近活动时间和最近内容摘要。
- **进展摘要**：基于会话索引和会话内容生成的、用自然语言描述的当前状态，供语音播报。
- **voiceAgent 契约**：`dsh-realtime-voice` 暴露的全双工语音服务接口，包含 `startConversation`、`registerActions`、`capabilities` 和会话句柄。本 Spec 复刻其契约，不依赖其实现。
- **动作（action）**：语音对话中，模型决定调用某个已注册的能力，例如「汇总进展」或「派发任务」。一次动作调用对应一次 `execute(args, control)`。
- **派发**：把一条任务文本投递到指定会话，对应 DSH 的 `sessionController.prompt`。
- **steer**：向一个**正在运行**的会话轮次注入新输入，使其立即改变方向；区别于 `queue`（排队等待当前轮次结束）。
- **PTT**：按住说话（push-to-talk）。用户按住按钮期间录音，松开后提交。
- **barge-in（开口打断）**：助理正在说话时，用户开口即打断播放。**本 Spec 第一版不做。**

## 范围说明

### In Scope

- **受管工作区范围内**、**未归档**会话的索引构建与刷新。
- 受管范围的设置界面：勾选工作区、持久化选择、实时启停。
- 会话状态汇总：运行中、已完成、失败、等待审批/回答。
- 基于索引的进展摘要生成（自然语言，可播报）。
- 归档与取消归档的实时响应：归档即退出索引，取消归档即重新纳入。
- 基于 DSH 核心 `ctx.speechToText` 的语音转写接入，支持按住说话。
- 复刻 `voiceAgent` 服务契约：`capabilities`、`startConversation`、`registerActions`、会话句柄方法与事件流。
- 意图路由：自然语言 → 汇总意图 / 派发意图。
- 向指定会话投递消息，支持 `queue` 与 `steer` 两种模式。
- 派发目标解析：从口语描述定位到具体会话，无法唯一确定时必须反问而不是猜测。
- 语音播报摘要（复用已有 TTS 能力或核心之外的可选实现）。

### Out of Scope

- **索引已归档会话**。归档会话只保留历史记录，不更新索引。
- **自动纳入工作区**。新增工作区默认不受管，必须由用户显式勾选。
- **对已归档会话派发**。目标已归档时拒绝并说明，不自动取消归档。
- **删除或修改归档会话的日志**。本 Spec 只读，不动历史数据。
- **回声消除与开口打断**。第一版用按住说话，不做 barge-in。理由见 `design.md` §7。
- 修改 DSH 核心或任何 `@deepseek-ai/*` 包。
- 依赖或 fork `dsh-realtime-voice`、`dsh-voice-mode`、`@biliye/dsh-voice-call` 等第三方语音插件。
- 绑定特定云端语音供应商。
- 唤醒词（wake word）。第一版明确由用户手势发起。
- 语音以外的输入方式改造（不改变现有键盘交互）。
- 派发内容的语义审查：System 不判断「这个任务该不该派」，只负责准确投递和回报结果。

## 需求

### 需求 1：会话索引覆盖全部工作区

**用户故事：** 作为用户，我希望助理知道我有多少会话、分别在哪个工作区，以便我不用自己逐个点开确认。

#### 验收标准

1. WHEN 助理需要会话索引 THEN System SHALL 通过 `ctx.sessionQuery.listSessions()` 取得**全部**会话，而不是只取当前工作区或只取工作区注册表中的会话。
2. WHEN 某个会话属于远端 Host THEN System SHALL 在索引中保留其来源 Host 标识，且该标识在派发时可用于定位。
3. WHEN 索引中每个会话 THEN System SHALL 至少记录：会话 ID、标题、所属工作区、来源 Host、运行状态、最近活动时间。
4. WHEN 某条会话信息缺失（例如标题为空、状态未知）THEN System SHALL 以明确的缺失值表示，不得用猜测值填充。
5. WHEN 会话数量超过一屏 THEN System SHALL 仍然返回完整索引，不得因为展示原因截断。
6. WHEN 会话未登记在任何工作区（实测本机有 59 个此类会话）THEN System SHALL 仍将其纳入索引，并归入「未分组」，不得丢弃。
7. WHEN 取会话标题 THEN System SHALL 使用会话日志中**最后一条** `session/title` 事件的值，不得取首条。

### 需求 2：会话内容读取用于摘要

**用户故事：** 作为用户，我希望摘要说的是「这个会话在干什么」而不是只报个标题，以便我判断要不要介入。

#### 验收标准

1. WHEN 需要生成某个会话的摘要 THEN System SHALL 通过 `ctx.sessionQuery` 读取该会话内容，优先使用实时会话而非持久化副本。
2. WHEN 会话内容很长 THEN System SHALL 采用有界读取（最近若干轮），不得把完整日志全部载入。
3. WHEN 读取某个会话失败 THEN System SHALL 只跳过该会话并在摘要中说明，不得让整个汇总失败。
4. WHEN 读取会话内容 THEN System SHALL NOT 因为读取行为而使该会话变为运行状态或产生副作用。
5. WHEN 会话包含工具调用与结果 THEN System SHALL 区分「用户意图」「助理回复」「工具动作」，摘要不得把工具输出误报成用户的话。
6. WHEN 读取会话内容用于摘要 THEN System SHALL 使用 `readSurface()` 或只读取语义事件（`user/message`、`assistant/message`、`turn/end`、`tool/call`），**不得**遍历原始事件日志。
7. WHEN 访问会话数据 THEN System SHALL 通过 `ctx.sessionQuery` 等核心服务，**不得**自行读取会话存储文件。

### 需求 3：进展摘要可播报

**用户故事：** 作为用户，我希望听到一段连贯的话说明当前进展，以便我在不看屏幕时也能掌握情况。

#### 验收标准

1. WHEN 用户询问进展 THEN System SHALL 生成一段自然语言摘要，覆盖：正在运行的会话、刚完成的会话、出错的会话、等待用户处理的会话。
2. WHEN 摘要中没有某类会话（例如没有任何会话在运行）THEN System SHALL 明确说出该类为空，不得静默省略导致用户误以为漏报。
3. WHEN 摘要用于语音播报 THEN System SHALL 避免 Markdown 排版符号、代码块和 URL，使其可直接朗读。
4. WHEN 摘要长度超过播报预算 THEN System SHALL 按优先级压缩（等待处理 > 出错 > 运行中 > 已完成），而不是从头截断。
5. WHEN 用户追问某个会话细节 THEN System SHALL 能基于同一份索引回答，不需要重新询问用户是哪个工作区。

### 需求 4：语音输入可用

**用户故事：** 作为用户，我希望按住按钮说话就能把话变成文字，以便不用打字。

#### 验收标准

1. WHEN 用户按住说话按钮 THEN System SHALL 采集麦克风音频并在松开后提交转写。
2. WHEN 转写完成 THEN System SHALL 使用 DSH 核心 `ctx.speechToText` 服务，并复用已下载的本地 SenseVoice 模型，不需要用户额外配置密钥。
3. WHEN 转写结果为空或明显无效 THEN System SHALL 不提交，并给出可读提示。
4. WHEN 麦克风权限被拒绝或设备不可用 THEN System SHALL 给出明确错误，且不影响键盘输入等既有功能。
5. WHEN 用户松开按钮 THEN System SHALL 立即停止录音，不得继续采集。
6. WHEN 转写正在进行 THEN System SHALL 向用户显示进行中状态，不得静默等待。

### 需求 5：复刻 voiceAgent 服务契约

**用户故事：** 作为维护者，我希望 CodingNS 有一个和 `dsh-realtime-voice` 行为等价、但归属自己的语音服务，以便不依赖第三方插件的发布节奏和供应商绑定。

#### 验收标准

1. WHEN 复刻完成 THEN System SHALL 提供名为 `voiceAgent` 的服务，暴露 `capabilities()`、`startConversation(options)`、`registerActions(ownerPrefix, actions)` 三个方法。
2. WHEN 调用 `capabilities()` THEN System SHALL 返回本实现实际支持的能力清单，**不得**声称支持尚未实现的能力。
3. WHEN 调用 `startConversation(options)` THEN System SHALL 返回一个会话句柄，至少包含 `id`、`subscribe`、`updateContext`、`interrupt`、`end`；事件一律通过 `subscribe()` 获取，**不得**依赖参考实现中并不存在的 `onEnd` / `onError` 回调。
4. WHEN 调用 `registerActions(ownerPrefix, actions)` THEN System SHALL 校验 `ownerPrefix` 非空、`actions` 为非数组对象、且每个 action 提供函数类型的 `execute`，不满足时抛 `TypeError`；返回带 `dispose()` 的注册句柄，`dispose()` 幂等且只移除自身条目。
5. WHEN 解析动作 THEN System SHALL 按 `ownerId` 是否以 `ownerPrefix` 开头来匹配，同名前缀后注册者优先；`ownerId` 为假值时静默不匹配，不报错。
6. WHEN 一个已匹配前缀下出现未注册的动作名 THEN System SHALL 返回 `{ ok: false, error: 'Unknown action: <name>' }`；参数校验失败时返回 `{ ok: false, error: 'Invalid action arguments.' }`。
7. WHEN action 的 `execute` 返回 Promise 且长时间不结束 THEN System SHALL 按超时（默认 300000 毫秒，可按 action 覆盖）以超时错误结算，不得永久挂起。
8. WHEN 动作被自动结算 THEN System SHALL 发出 `action-result` 事件，包含 `callId`、`name`、`ok`、`output`、`error`，且 `output` 做递归 4000 字符截断。
9. WHEN 动作的触发 THEN System SHALL 由事件发出路径自动分发，不引入独立的 invoke API。
10. WHEN `execute` 调用 `control.resolve(result)` THEN System SHALL 幂等结算并返回 boolean。
11. WHEN 与 `dsh-realtime-voice` 的 `spec/runtime-contract.json` 对比 THEN System SHALL 在契约面（方法名、事件名、owner 匹配规则、超时语义、错误文案）上保持一致；实现细节与供应商适配**允许**不同。
12. WHEN 参考实现的契约文件与实际代码不一致（例如 `interrupted` 事件未在契约文件中声明）THEN System SHALL 以**代码行为**为准，并在调查文档中记录该差异。
13. WHEN 复刻实现与参考实现在行为上有意不一致 THEN System SHALL 在 `docs/` 中记录差异及理由。

### 需求 6：向指定会话派发

**用户故事：** 作为用户，我希望说一句「让 X 去做 Y」就能把任务发过去，以便不用切会话手动输入。

#### 验收标准

1. WHEN 用户表达派发意图并指定了目标会话与任务内容 THEN System SHALL 通过 `ctx.sessionController.prompt({ requestId, sessionId, mode, content })` 投递。
2. WHEN 目标是正在运行的会话且用户要求立即改变方向 THEN System SHALL 使用 `mode: 'steer'`；否则使用 `mode: 'queue'`。
3. WHEN 目标会话无法唯一确定（例如用户说「那个会话」，但有多个候选）THEN System SHALL 反问澄清，**不得**猜测目标。
4. WHEN 目标会话不存在或已被归档 THEN System SHALL 返回结构化错误并说明，不得回退到最近活跃的会话。
5. WHEN 派发成功 THEN System SHALL 向用户回报目标会话名称与投递模式（排队 / 注入）。
6. WHEN `requestId` 重复 THEN System SHALL 依赖 DSH 的幂等语义，不得重复插入消息。
7. WHEN 派发的任务文本为空或只包含目标描述 THEN System SHALL 拒绝派发并提示补充任务内容。
8. WHEN 目标会话属于远端 Host THEN System SHALL 复用 spec006 的既有通道，不新建第二套跨 Host 派发路径。

### 需求 7：等待用户处理的会话优先暴露

**用户故事：** 作为用户，我希望助理主动告诉我「有东西在等我处理」，以便不遗漏审批和提问。

#### 验收标准

1. WHEN 有会话处于等待审批或等待回答 THEN System SHALL 在进展摘要中**优先**列出，且明确说明需要用户做什么。
2. WHEN 用户询问进展 THEN System SHALL 主动包含等待处理项，即使该类为空也要说明「没有待处理项」。
3. WHEN 等待项存在 THEN System SHALL 提供对应会话的可定位标识，使用户能直接跳转。
4. WHEN 会话状态数据源不含等待审批信息（`SessionSummary` 只有 `running` 与 `completed`）THEN System SHALL 通过审批/提问事件另行获取，不得把「运行中」误报为「等待处理」。

### 需求 8：受管工作区范围由用户手动选定

**用户故事：** 作为用户，我希望自己决定助理管哪些工作区，以便它只关心我正在推进的项目，不去读我不想让它碰的目录。

#### 验收标准

1. WHEN 助理首次启用 THEN System SHALL 默认**不纳入任何工作区**，或仅纳入用户在设置中显式勾选的工作区，不得自动纳入全部工作区。
2. WHEN 用户勾选或取消勾选某个工作区 THEN System SHALL 在设置中持久化该选择，并在下次启动时恢复。
3. WHEN 受管范围发生变化 THEN System SHALL 立即重建索引，使新增工作区的会话进入索引、移除工作区的会话退出索引。
4. WHEN 某个工作区不在受管范围内 THEN System SHALL NOT 读取其会话内容，也不得在摘要中提及。
5. WHEN 用户在受管范围之外要求汇总或派发 THEN System SHALL 明确告知该目标不在受管范围内，并提供加入受管范围的入口，不得静默忽略。
6. WHEN 用户在受管范围之外要求派发 THEN System SHALL NOT 向其投递消息。
7. WHEN 受管范围为空 THEN System SHALL 明确提示用户尚未选择任何工作区，而不是报告"没有进展"。
8. WHEN 需要展示可选工作区列表 THEN System SHALL 使用 `ctx.workspaceRegistry` 的完整列表，包含用户尚未勾选的工作区。
9. WHEN 受管范围包含远端 Host 的工作区 THEN System SHALL 沿用 spec006 的既有通道，不新建第二套聚合路径。

### 需求 9：仅索引未归档会话

**用户故事：** 作为用户，我希望助理只关心还在推进的会话，以便摘要说的是当前状态，而不是几个月前就结束的工作。

#### 验收标准

1. WHEN 构建索引 THEN System SHALL 通过 `ctx.workspaceRegistry` 的 `archivedSessionIds` 排除已归档会话。
2. WHEN 某个会话被归档 THEN System SHALL 将其从索引中移除，并停止对其的一切更新订阅。
3. WHEN 某个会话被取消归档 THEN System SHALL 将其重新纳入索引。
4. WHEN 已归档会话存在 THEN System SHALL 保留其历史记录不动，**不得**删除、修改或压缩其日志。
5. WHEN 摘要生成 THEN System SHALL NOT 包含已归档会话，即使它最近有活动。
6. WHEN 用户明确询问某个已归档会话 THEN System SHALL 说明该会话已归档且不在受管范围内，而不是假装它不存在。
7. WHEN 派发目标是一个已归档会话 THEN System SHALL 拒绝派发并说明原因，不得自动取消归档或向已归档会话投递。
8. WHEN 归档状态发生变化（归档或取消归档）THEN System SHALL 在无需重启的前提下更新索引。
9. WHEN 索引读取会话 THEN System SHALL NOT 因读取而使已归档会话重新变为活跃状态。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 用户询问进展 THEN System SHALL 在 3 秒内开始播报摘要（不含模型生成时间），索引读取不得成为瓶颈。
2. WHEN 索引已存在且无会话状态变化 THEN System SHALL 复用缓存，不重复全量读取。
3. WHEN 索引构建 THEN System SHALL 只扫描受管范围内、未归档的会话；实测该范围（90 个活跃会话）的读取耗时为 **0.91 秒**，全量（542 个会话）为 6.49 秒。
4. WHEN 摘要生成 THEN System SHALL 不对 DSH 主进程造成可感知的卡顿；索引构建与摘要读取必须在 Host 侧异步执行，不得阻塞会话处理。
5. WHEN 语音转写 THEN System SHALL 在松开按钮后 2 秒内给出转写结果（使用本地模型时）。
6. WHEN 受管范围包含的工作区数量增加 THEN System SHALL 保持读取耗时与"受管范围内未归档会话数"成正比，不得因范围外会话数量增长而变慢。

### 非功能需求 2：可靠性

1. WHEN 某个会话读取失败 THEN System SHALL 降级为跳过该会话并说明，不得整体失败。
2. WHEN 语音服务不可用 THEN System SHALL 保持键盘输入路径完全可用。
3. WHEN 派发请求失败 THEN System SHALL 返回结构化错误（含失败环节），不得只报「失败了」。
4. WHEN 麦克风资源被其他消费者占用 THEN System SHALL 返回明确的占用错误，不得静默失败。
5. WHEN Host 重启或页面刷新 THEN System SHALL 能从持久化会话日志重建索引，不依赖内存状态。

### 非功能需求 3：可维护性

1. WHEN 需要新增一种语音供应商 THEN System SHALL 通过实现供应商适配接口接入，不修改意图路由与会话汇聚代码。
2. WHEN 需要新增一种语音意图 THEN System SHALL 通过注册 action 接入，不修改语音服务本身。
3. WHEN 排查问题 THEN System SHALL 记录：转写文本、识别到的意图、解析出的目标会话、投递模式与结果。
4. WHEN 复刻实现与参考实现出现行为分歧 THEN System SHALL 以 `docs/` 中的契约记录为准，并在变更时同步更新该记录。

### 非功能需求 4：安全与隐私

1. WHEN 采集麦克风音频 THEN System SHALL 明确告知用户正在录音，并在松开后立即停止。
2. WHEN 使用本地识别 THEN System SHALL 保证音频不出本机；若使用云端识别，SHALL 在启用前明确告知。
3. WHEN 读取会话内容用于摘要 THEN System SHALL 只读取生成摘要所需的有界内容，不建立额外的持久副本。
4. WHEN 会话内容包含凭据或密钥 THEN System SHALL 在摘要与播报中避免原样输出敏感字段。
5. WHEN 派发任务 THEN System SHALL 不因为语音渠道而绕过 DSH 已有的权限与审批边界。

## 成功定义

- 用户在设置中勾选若干工作区后，按住说话、说「现在进展怎么样」，能听到一段覆盖**这些工作区中未归档会话**状态的语音摘要。
- 摘要不包含已归档会话，也不会把早已结束的工作报成当前进展。
- 用户说「让 X 会话去做 Y」，任务被准确投递到目标会话，并回报目标与模式。
- 目标不唯一、或目标不在受管范围内时，助理会反问或明确告知，而不是猜。
- 复刻的 `voiceAgent` 服务通过契约对照检查，与参考实现在方法名、事件名、owner 匹配、超时语义上一致。
- 语音不可用时，键盘路径不受影响；某个会话读取失败不影响整体汇总。
- 索引构建耗时可复现地低于 1.5 秒（受管范围内 90 个活跃会话的实测值为 0.91 秒）。
- 全部验收标准有对应测试或可复现的手工验证记录。

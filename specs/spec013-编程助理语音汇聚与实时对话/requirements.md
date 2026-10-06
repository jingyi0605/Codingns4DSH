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
- **voiceAgent 契约**：CodingNS 自有的语音服务接口，包含 `startConversation`、`registerActions`、`capabilities` 和会话句柄。Host 通过 `VoiceRuntimeAdapter` 按需接入 `sherpa-onnx-node`，保留自己的业务动作边界；历史 `dsh-realtime-voice` 只用于契约对照。
- **动作（action）**：语音对话中，模型决定调用某个已注册的能力，例如「汇总进展」或「派发任务」。一次动作调用对应一次 `execute(args, control)`。
- **派发**：把一条任务文本投递到指定会话，对应 DSH 的 `sessionController.prompt`。
- **steer**：向一个**正在运行**的会话轮次注入新输入，使其立即改变方向；区别于 `queue`（排队等待当前轮次结束）。
- **全局语音会话**：Host/Profile 级唯一语音上下文，不绑定当前打开的 DSH 会话；目标会话只在意图解析和派发阶段产生。
- **常开麦克风**：语音运行时持续采集音频，由唤醒词和端点状态决定何时把语音交给助理。
- **barge-in（开口打断）**：助理正在播放时，用户开口即可停止当前播放并进入新的语音轮次。
- **VoiceRuntimeAdapter**：语音运行时适配边界，连接 Client 设备与 Profile 的成熟 ASR/VAD/TTS、流式音频和打断；不负责 CodingNS 的会话索引与派发。
- **客户端音频设备管理**：运行在浏览器 Client 的设备枚举、用户选择、权限状态、设备断开与重新连接管理；设备标识只在所属浏览器来源内使用，不上传为 Host 的硬件标识。

## 范围说明

### In Scope

- **受管工作区范围内**、**未归档**会话的索引构建与刷新。
- 受管范围的设置界面：勾选工作区、持久化选择、实时启停。
- 会话状态汇总：运行中、已完成、失败、等待审批/回答。
- 基于索引的进展摘要生成（自然语言，可播报）。
- 归档与取消归档的实时响应：归档即退出索引，取消归档即重新纳入。
- 基于按需加载的 `sherpa-onnx-node` 提供流式 ASR、可选 VAD 和本地模型能力；包或模型不可用时返回结构化不可用状态，不调用 DSH 核心 `ctx.speechToText` 回退。
- 浏览器 Client 由 CodingNS 自己负责输入设备枚举、选择、权限提示、设备变化处理和采集状态；Host 不直接访问 Web 客户端的麦克风，只接收同源 HTTPS PCM 流。
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
- **全双工音频运行时**不再属于 Out of Scope；必须通过可替换适配器接入按需加载的 Sherpa-ONNX，并完成契约和假运行时测试。真实设备验收另需明确授权的 Stage0 测试。
- 修改 DSH 核心或任何 `@deepseek-ai/*` 包。
- 把第三方插件的 UI、当前会话绑定或供应商方言直接复制进 CodingNS。语音运行时不能替代 CodingNS 的全局协调、索引、意图和派发边界。
- 绑定特定云端语音供应商或在未告知用户的情况下上传音频。
- 绕过浏览器的麦克风权限或在非安全上下文中强行访问设备。局域网 Web 访问必须由 HTTPS/WSS 等安全来源承载；浏览器不支持时只能给出明确提示并保留普通文字输入。
- 以页面当前会话作为全局语音上下文，或让唤醒词直接决定派发目标。
- 语音以外的输入方式改造（不改变现有键盘交互）。
- 派发内容的语义审查：System 不判断「这个任务该不该派」，只负责准确投递和回报结果。

## 需求

### 需求 1：会话索引覆盖受管范围内的全部会话

**用户故事：** 作为用户，我希望助理知道**我让它管的那些工作区**里有多少会话、分别在干什么，以便我不用自己逐个点开确认。

#### 验收标准

1. WHEN 助理需要会话索引 THEN System SHALL 通过 `ctx.sessionQuery.listSessions()` 取得会话全集，再按受管工作区范围过滤，而不是只取当前工作区。
2. WHEN 某个会话属于远端 Host THEN System SHALL 在索引中保留其来源 Host 标识，且该标识在派发时可用于定位。
3. WHEN 索引中每个会话 THEN System SHALL 至少记录：会话 ID、标题、所属工作区、来源 Host、运行状态、最近活动时间。
4. WHEN 某条会话信息缺失（例如标题为空、状态未知）THEN System SHALL 以明确的缺失值表示，不得用猜测值填充。
5. WHEN 会话数量超过一屏 THEN System SHALL 仍然返回完整索引，不得因为展示原因截断。
6. WHEN 某个会话不在受管工作区范围内 THEN System SHALL NOT 将其纳入索引，也不得读取其内容。
7. WHEN 取会话标题 THEN System SHALL 使用会话日志中**最后一条** `session/title` 事件的值，不得取首条。
8. WHEN 索引包含多个工作区 THEN System SHALL 保留每个会话的工作区归属，使摘要能按工作区分组。

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
8. WHEN 需要生成摘要 THEN System SHALL 只读取受管范围内、未归档的会话；范围外与已归档会话的内容不得被读取。
9. WHEN 摘要生成完成 THEN System SHALL 释放本次读取的会话内容，不建立额外的持久副本。

### 需求 3：进展摘要可播报

**用户故事：** 作为用户，我希望听到一段连贯的话说明当前进展，以便我在不看屏幕时也能掌握情况。

#### 验收标准

1. WHEN 用户询问进展 THEN System SHALL 生成一段自然语言摘要，覆盖：正在运行的会话、刚完成的会话、出错的会话、等待用户处理的会话。
2. WHEN 摘要中没有某类会话（例如没有任何会话在运行）THEN System SHALL 明确说出该类为空，不得静默省略导致用户误以为漏报。
3. WHEN 摘要用于语音播报 THEN System SHALL 避免 Markdown 排版符号、代码块和 URL，使其可直接朗读。
4. WHEN 摘要长度超过播报预算 THEN System SHALL 按优先级压缩（等待处理 > 出错 > 运行中 > 已完成），而不是从头截断。
5. WHEN 用户追问某个会话细节 THEN System SHALL 能基于同一份索引回答，不需要重新询问用户是哪个工作区。

### 需求 4：全双工语音输入与实时打断

**用户故事：** 作为用户，我希望不必盯着页面就能通过唤醒词进行持续语音对话，并在助理播报时随时插话；运行时不可用时能看到明确错误并继续使用文字输入。

#### 验收标准

1. WHEN 全局语音会话启动 THEN System SHALL 在 Host/Profile 级取得唯一语音租约，并让当前 Client 采集音频；不得绑定当前页面会话。
2. WHEN 采集到音频帧 THEN System SHALL 经 `VoiceRuntimeAdapter` 交给 Host Sherpa 运行时的流式 PCM 数据面，不得等到整段录音结束后才处理。
3. WHEN 唤醒词被识别 THEN System SHALL 从 standby 进入 listening，并把后续语音交给语音对话；唤醒词本身不得选择派发目标。
4. WHEN 助理正在播放且检测到用户开口 THEN System SHALL 停止当前播放、丢弃旧播放 epoch 的迟到帧，并立即开始新的语音轮次。
5. WHEN 转写结果为空或明显无效 THEN System SHALL 不提交，并给出可读提示。
6. WHEN 麦克风权限被拒绝或设备不可用 THEN System SHALL 给出明确错误，且不影响键盘输入等既有功能。
7. WHEN 实时运行时不可用 THEN System SHALL 返回结构化不可用状态，不得调用 DSH 核心 `ctx.speechToText` 或其他语音转写回退，并保留普通文字输入。
8. WHEN 语音会话结束或被打断 THEN System SHALL 释放麦克风租约和音频资源，不得继续采集。
9. WHEN 本地 TTS 被启用 THEN System SHALL 按句生成可中断的音频片段，并在每个片段开始前检查播放 epoch；在没有真正流式 TTS 实现前，不得将 `streamingOutput` 报告为 true。
10. WHEN Client 采集并传输 PCM 帧 THEN System SHALL 保留其可取消的持续流、序号、采样率、声道数和 epoch 语义；CodingNS 不得把每一帧复制成无界 JSON 历史记录。
11. WHEN PCM 音频流断开或 Host generation 变化 THEN System SHALL 立即停止旧流、丢弃旧 epoch 的帧，并回到可恢复的 standby 或降级状态。

### 需求 5：复刻 voiceAgent 服务契约

**用户故事：** 作为维护者，我希望 CodingNS 有一个和参考实现契约兼容、但归属自己的语音服务，以便不依赖第三方插件的发布节奏和供应商绑定。

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
11. WHEN 对照 `dsh-realtime-voice` 的 `voiceAgent` 契约 THEN System SHALL 在控制面的方法名、事件名、owner 匹配规则、超时语义和错误文案上保持一致；默认语音数据面通过 `VoiceRuntimeAdapter` 接入按需加载的 `sherpa-onnx-node`，不复制供应商协议，也不接入 DSH `speechToText` 回退。
12. WHEN 参考实现的契约文件与实际代码不一致（例如 `interrupted` 事件未在契约文件中声明）THEN System SHALL 以**代码行为**为准，并在调查文档中记录该差异。
13. WHEN 复刻实现与参考实现在行为上有意不一致 THEN System SHALL 在 `docs/` 中记录差异及理由。

### 需求 9：语音运行时与模型按需安装

**用户故事：** 作为用户，我希望基础插件不因为语音功能变重，只有启用全局助理时才安装本地运行时和模型。

#### 验收标准

1. WHEN 用户未启用全局语音助理 THEN System SHALL 不启动语音会话或占用麦克风，核心插件仍可正常启动和使用键盘功能。
2. WHEN 用户启用全局语音助理 THEN System SHALL 按需动态解析 `sherpa-onnx-node` 与当前平台匹配的原生包，不得在核心模块顶层静态导入原生包。
3. WHEN 用户选择 Sherpa 语言或能力 THEN System SHALL 只下载对应的 ASR、VAD、KWS 或 TTS 模型，不得把所有模型打进插件包。
4. WHEN 可选替代运行时模型下载完成 THEN System SHALL 校验文件摘要、写入版本化缓存，并在校验失败时删除不完整文件。
5. WHEN Sherpa Runtime 或模型不可用 THEN System SHALL 返回结构化能力缺失状态，不得声称支持全双工能力，也不得影响键盘输入。
6. WHEN 用户卸载或停用语音助理 THEN System SHALL 停止采集、释放运行时资源，并保留普通会话功能。
7. WHEN Runtime 包升级 THEN System SHALL 使不兼容的模型缓存失效，不能静默复用旧模型。

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

### 需求 10：浏览器客户端音频设备管理

**用户故事：** 作为通过局域网 Web 页面使用 CodingNS 的用户，我希望语音助理使用我当前浏览器设备的麦克风，而不是要求运行 CodingNS 的 Host 主机拥有麦克风；我还希望能选择、切换并查看当前使用的设备。

#### 验收标准

1. WHEN 全局语音入口在浏览器 Client 中初始化 THEN System SHALL 由 CodingNS Client 通过 `navigator.mediaDevices.enumerateDevices()` 探测音频输入设备并保留设备状态；不得把 Host 的 `node-cpal` 设备列表当作 Web 客户端设备列表。
2. WHEN 用户首次启用麦克风 THEN System SHALL 由 CodingNS Client 通过 `getUserMedia({ audio: ... })` 触发浏览器原生权限提示，并由全局入口明确说明正在使用麦克风；不得在用户未触发语音入口时静默申请权限。
3. WHEN 用户选择输入设备 THEN System SHALL 由 CodingNS Client 将选择作为本地偏好保存并在下次启动尝试恢复；设备 ID 失效、权限变化或设备被拔出时必须重新枚举并报告状态，不得静默切换到未知设备。
4. WHEN Client 建立采集流 THEN System SHALL 优先使用用户选择的 `deviceId`，通过 `AudioWorklet` 或等价实时 Web Audio 管线输出 16 kHz、单声道、PCM16 帧；CodingNS 适配器不得要求 Host 读取浏览器原始设备。
5. WHEN 浏览器触发 `devicechange`、MediaStreamTrack `ended` 或权限状态变更 THEN System SHALL 由 CodingNS Client 停止旧采集流、刷新设备状态、清理旧音频 epoch，并报告可恢复状态；不得继续发送旧设备的 PCM。
6. WHEN 同一 Host 存在多个浏览器标签页或多个 Client THEN System SHALL 通过每页面唯一 owner ID 取得全局租约，只允许一个 Client 持有麦克风采集租约；租约释放和页面关闭必须可恢复，设备 ID 和设备摘要不上传到 Host 之外的服务。
7. WHEN 用户在局域网地址访问 Web 页面 THEN System SHALL 检查当前来源是否为安全上下文，并在不满足浏览器 `getUserMedia` 要求时明确提示用户改用 HTTPS/WSS 或受支持的安全来源；不得通过 RPC、iframe 或 Host 代理绕过该限制。
8. WHEN 麦克风权限被拒绝、浏览器不支持 `getUserMedia`/`AudioWorklet`、设备不存在或设备被其他应用占用 THEN System SHALL 返回结构化设备错误，保留普通文字输入，不得让全局助理进入“已启动但无音频”的假状态。
9. WHEN 用户切换输入设备 THEN System SHALL 由 CodingNS Client 在停止旧轨道后再创建新轨道，并让新的音频流使用新的 sequence/epoch；旧设备的迟到帧必须被丢弃。
10. WHEN 用户选择播放设备且浏览器支持 `HTMLMediaElement.setSinkId()` THEN System SHALL 对本地音频元素应用该选择并报告是否成功；使用浏览器 `speechSynthesis` 时只能报告浏览器/操作系统默认输出设备，不得声称已控制输出设备。
11. WHEN Client 断开、页面刷新或语音助理停用 THEN System SHALL 停止所有 MediaStreamTrack、断开 AudioWorklet、释放 Host 租约，并保留用户的设备偏好供下次恢复。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 用户询问进展 THEN System SHALL 在 3 秒内开始播报摘要（不含模型生成时间），索引读取不得成为瓶颈。
2. WHEN 索引已存在且无会话状态变化 THEN System SHALL 复用缓存，不重复全量读取。
3. WHEN 索引构建 THEN System SHALL 只扫描受管范围内、未归档的会话；实测该范围（89 个活跃会话）的读取耗时为 **1.03 秒**，全量（543 个会话）为 6.56 秒。
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

1. WHEN 需要新增一种语音运行时 THEN System SHALL 通过实现 `VoiceRuntimeAdapter` 接入，不修改意图路由与会话汇聚代码。
2. WHEN 需要新增一种语音意图 THEN System SHALL 通过注册 action 接入，不修改语音服务本身。
3. WHEN 排查问题 THEN System SHALL 记录：转写文本、识别到的意图、解析出的目标会话、投递模式与结果。
4. WHEN 复刻实现与参考实现出现行为分歧 THEN System SHALL 以 `docs/` 中的契约记录为准，并在变更时同步更新该记录。

### 非功能需求 4：安全与隐私

1. WHEN 采集麦克风音频 THEN System SHALL 明确告知用户正在录音，并在松开后立即停止。
2. WHEN 使用本地识别 THEN System SHALL 保证音频不出本机；若使用云端识别，SHALL 在启用前明确告知。浏览器设备列表和 `deviceId` 不得上传给 Host 之外的服务。
3. WHEN 读取会话内容用于摘要 THEN System SHALL 只读取生成摘要所需的有界内容，不建立额外的持久副本。
4. WHEN 会话内容包含凭据或密钥 THEN System SHALL 在摘要与播报中避免原样输出敏感字段。
5. WHEN 派发任务 THEN System SHALL 不因为语音渠道而绕过 DSH 已有的权限与审批边界。

## 成功定义

- 用户在设置中勾选若干工作区后，唤醒全局语音助理并说「现在进展怎么样」，能听到一段覆盖**这些工作区中未归档会话**状态的流式语音摘要；助理播报时插话可以立即打断。
- 用户通过局域网 HTTPS Web 页面启用语音后，能够在该浏览器中枚举、选择和切换麦克风；助理使用所选 Client 设备，不要求 Host 主机拥有麦克风。
- 摘要不包含已归档会话，也不会把早已结束的工作报成当前进展。
- 用户说「让 X 会话去做 Y」，任务被准确投递到目标会话，并回报目标与模式。
- 目标不唯一、或目标不在受管范围内时，助理会反问或明确告知，而不是猜。
- 复刻的 `voiceAgent` 服务通过契约对照检查，与参考实现在方法名、事件名、owner 匹配、超时语义上一致。
- 语音不可用时，键盘路径不受影响；某个会话读取失败不影响整体汇总。
- 索引构建耗时可复现地低于 1.5 秒（受管范围内 89 个活跃会话的实测值为 1.03 秒）。
- 全部验收标准有对应测试或可复现的手工验证记录。

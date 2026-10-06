# 任务清单 - 编程助理语音汇聚与实时对话

状态：阶段 1、阶段 2、阶段 3、阶段 4.0、4.1、4.1.1、4.2、4.3、4.4 已完成；阶段 5.2 IN_REVIEW（等待真实 HTTPS Web 设备验收）；阶段 5.3 已完成。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写验证证据

## 阶段 1：契约验证与调查

- [x] 1.1 验证 voiceAgent 契约面
  - 状态：DONE
  - 证据：`docs/20261004-voiceAgent服务契约调查.md`。已逐条核实 `registerActions`（`client.js:1009-1043`）、`control.resolve`（`:1101-1108`）、默认超时（`:52`）、4000 字符截断（`:1047`）、错误文案（`:1079`/`:1084`）、动作自动分发（`:291-298`）；确认服务注册在 Client 侧（`:910-914`）；确认 `realtimeVoice` 别名与 `interrupted` 事件均未在契约文件中声明；确认 `startConversation` 无 `onEnd`/`onError`。
  - 这一步到底做什么：把 `dsh-realtime-voice@0.3.3` 的 `spec/runtime-contract.json`、`client/client.js` 与 `dsh/service.js` 读一遍，逐条记录方法名、事件名、owner 匹配规则、超时语义、错误文案，写进调查文档。
  - 做完你能看到什么：一份可以照着实现的契约清单，每条都有出处（文件 + 行号）。
  - 先依赖什么：无。
  - 开始前先看：`design.md` §6；`requirements.md` 需求 5。
  - 主要改哪里：只新增 `docs/20261004-voiceAgent服务契约调查.md`，不动源码。
  - 这一步先不做什么：不复制插件 UI 或供应商方言；这里只记录契约，不在调查阶段改 DSH 核心。
  - 怎么算完成：契约清单覆盖 `capabilities`、`startConversation`、`registerActions`、会话句柄方法、9 种事件、超时与 owner 匹配规则、错误文案；并记录契约文件与代码不一致之处。
  - 怎么验证：`npm view dsh-realtime-voice dist.tarball` 取包解压，对照文件逐条核对；文档中标注「已核实」与「仅 README 声称」。

- [x] 1.2 确认 DSH 核心会话查询与语音能力边界
  - 状态：DONE
  - 证据：`docs/20261004-会话汇聚与语音能力调查.md`。实测本机 543 个唯一会话（594 个格式文件，47 个会话多格式并存）/ 552,246 事件 / 334.8 MB，全量读取 6.56 秒；确认 `listSessions()` 返回 `{header,live,persisted}` 包装；确认 `SessionHeader` 不含 `title`/`workspaceId`；确认标题来自日志最后一条 `session/title`；确认 59 个游离会话；确认三种存储格式并存；确认 `approval/asked` 事件存在；确认核心无 TTS。
  - 这一步到底做什么：确认 `ctx.sessionQuery` 各方法在本机可用、返回结构、`readSurface` 的返回形态、`ctx.speechToText` 的 provider 接口、会话存储格式与读取成本，以及等待审批状态的正确来源。
  - 做完你能看到什么：知道哪些能力直接可用、哪些需要降级、哪些不可用，以及索引的真实数据来源。
  - 先依赖什么：无。
  - 开始前先看：`design.md` §3、§7；`requirements.md` 需求 1、2、4、7。
  - 主要改哪里：只新增 `docs/20261004-会话汇聚与语音能力调查.md`。
  - 这一步先不做什么：不修改 DSH 核心，不新增依赖，不安装插件。
  - 怎么算完成：索引数据来源、读取成本量级、等待处理状态来源、STT provider 接口、存储格式版本均有结论。
  - 怎么验证：在本机 DSH 0.2.0-rc.2 上做只读探测与真实数据实测；记录实际观察值与耗时。

- [x] 1.3 验证 Sherpa-ONNX Node 本项目功能可行性
  - 状态：DONE
  - 证据：`docs/调查报告/20261005-sherpa-onnx-node本项目功能可行性验证.md`。在 Node 22/macOS arm64 临时目录真实安装 `sherpa-onnx-node@1.13.8`，完成流式中文 ASR、Silero VAD、关键词唤醒和中文 VITS TTS 模型推理；同时探测 `node-cpal@1.0.0` 的 CoreAudio 设备边界。
  - 这一步到底做什么：确认 Sherpa 是否能覆盖需求 4 的本地识别、VAD、唤醒和播报基础能力，并找出与当前 CodingNS Host/Client 传输的集成缺口。
  - 做完你能看到什么：知道哪些能力已经真实跑通，哪些能力需要新增音频数据面或设备授权，避免把模型 API 探测误写成全局语音完成。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §7；`requirements.md` 需求 4、需求 9。
  - 主要改哪里：只新增可行性调查文档，不修改核心插件依赖。
  - 这一步先不做什么：不启动 DSH 开发服务器，不把 Sherpa 原生包加入默认 Profile，不执行真实麦克风录音。
  - 怎么算完成：安装、动态加载、流式 ASR、VAD、KWS、TTS、平台设备探测和当前 RPC 数据面缺口均有可复现结论。
  - 怎么验证：临时目录执行 `npm install sherpa-onnx-node@1.13.8`；使用官方模型和样例音频逐帧推理；记录模型、耗时、输出和失败边界。

## 阶段 2：纯逻辑模块

- [x] 2.0 受管范围与归档过滤的纯逻辑
  - 状态：DONE
  - 证据：`src/host/features/assistant-scope.ts` 与 `tests/assistant-scope.spec.ts`。范围固定为「用户勾选工作区 ∩ 未归档会话」；空范围返回 `no-managed-workspaces`；范围外和已归档目标分别返回结构化拒绝原因；归档集合取消后会话重新纳入；函数不修改输入。
  - 这一步到底做什么：实现 `AssistantScope` 结构与 `assistant-scope` 纯逻辑：受管工作区集合、空范围判定、范围过滤、归档集合过滤、范围外目标的拒绝判定。
  - 做完你能看到什么：给定一份会话全集和一份范围配置，能得到「应该索引哪些会话」的确定结果。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §3.0、§3.1；`requirements.md` 需求 8、需求 9。
  - 主要改哪里：新增 `src/host/features/assistant-scope.ts` 与测试。
  - 这一步先不做什么：不读写真实设置，不接触真实注册表（用注入的接口）。
  - 怎么算完成：范围为空时返回明确状态而非空列表；范围外会话被排除；归档会话被排除；取消归档后重新纳入；过滤是纯函数、无副作用。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json` 通过；`node --test tests/assistant-scope.spec.ts` 通过（7/7）；`git diff --check` 通过。覆盖空范围、单工作区、多工作区、全部归档、取消归档重纳入、范围外/已归档目标和纯函数无副作用。

- [x] 2.1 会话索引数据结构与摘要逻辑
  - 状态：DONE
  - 证据：`src/shared/contracts/assistant.ts`、`src/host/features/assistant-summary.ts` 与 `tests/assistant-summary.spec.ts`。实现索引条目/快照契约、待处理/出错/运行中/已完成优先级、空类目提示、空范围提示、Markdown/URL/代码/敏感字段清理和输入不可变保证；兼容导出 `buildAssistantSummary`、`summarizeAssistantSessions`、`normalizeSpeechText`、`redactSensitiveValues`。
  - 这一步到底做什么：实现 `SessionIndexEntry` 结构与 `assistant-summary` 纯逻辑，包括优先级压缩、空类目说明、敏感字段过滤、播报文本净化。
  - 做完你能看到什么：给定一份索引快照，能得到一段可直接朗读的摘要文本。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §3.2、§4；`requirements.md` 需求 3、需求 7。
  - 主要改哪里：新增 `src/shared/contracts/assistant.ts` 与 `src/host/features/assistant-summary.ts`（或等价位置）、对应测试。
  - 这一步先不做什么：不接真实数据源，不调模型。
  - 怎么算完成：优先级顺序正确；某类为空时摘要明确说明；文本不含 Markdown、URL、代码块；敏感形态字符串被过滤；索引中不含已归档会话时摘要不提及它们。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/assistant-summary.spec.ts tests/assistant-scope.spec.ts` 通过（12/12）；`git diff --check` 通过。

- [x] 2.2 意图解析与目标定位
  - 状态：DONE
  - 证据：`src/host/features/assistant-intent.ts` 与 `tests/assistant-intent.spec.ts`。实现汇总/派发/澄清/闲聊分类、标题精确/包含/工作区序数/最近匹配、歧义澄清、显式 `steer`、`queue` 默认、范围外与已归档结构化拒绝，并为目标引用携带 `sessionId`、`workspaceId`、`hostId`、`indexGeneration`。
  - 这一步到底做什么：实现 `assistant-intent` 纯逻辑：意图分类、目标解析四级匹配、多候选澄清判定、派发模式选择、**范围外目标的拒绝判定**。
  - 做完你能看到什么：给一句话和一份索引，得到意图、目标会话或澄清请求。
  - 先依赖什么：2.0、2.1。
  - 开始前先看：`design.md` §5；`requirements.md` 需求 6、需求 8 验收标准 5、需求 9 验收标准 7。
  - 主要改哪里：新增 `src/host/features/assistant-intent.ts` 与测试。
  - 这一步先不做什么：不调用模型做意图分类（第一版用规则），不做真实投递。
  - 怎么算完成：精确/包含/序数/最近四级匹配各自有测试；多候选时返回澄清而不是猜测；`steer` 只在明确要求时选择；目标在范围外或已归档时返回明确的拒绝原因而非静默忽略。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/assistant-intent.spec.ts` 通过（6/6）；`git diff --check` 通过。

- [x] 2.3 voiceAgent 服务与动作注册表
  - 状态：DONE
  - 证据：`src/host/features/voice-agent-service.ts`、`src/host/features/index.ts` 与 `tests/voice-agent-service.spec.ts`。Host 侧服务实现 `capabilities`、`startConversation`、`registerActions`、事件路径自动动作分发、owner 前缀优先级、幂等控制结算、超时和递归 4000 字符截断；默认能力诚实报告为未接入实时运行时，不绑定当前 DSH 会话。
  - 这一步到底做什么：实现 `voiceAgent` 服务的契约面与动作注册表：`execute` 校验、`dispose` 语义、owner 前缀匹配、后注册者优先、未注册动作报错、超时结算、`action-result` 事件、`control.resolve` 幂等结算。
  - 做完你能看到什么：第三方代码可以注册动作，并得到与参考实现一致的行为。
  - 先依赖什么：1.1。
  - 开始前先看：`design.md` §6.3、§6.3.1；`requirements.md` 需求 5；`docs/20261004-voiceAgent服务契约调查.md` §5。
  - 主要改哪里：新增 `src/host/features/voice-agent-service.ts` 与测试。
  - 这一步先不做什么：不接具体音频运行时，不把 barge-in 或供应商方言塞进 voiceAgent 契约层。
  - 怎么算完成：`design.md` §6.3 列出的 11 条保真行为逐条有测试；错误文案逐字一致；`capabilities()` 不声称未实现的能力。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/voice-agent-service.spec.ts` 通过（5/5）；`git diff --check` 通过。

### 阶段检查 2.4

- [x] 2.4 纯逻辑层复查
  - 状态：DONE
  - 证据：范围、摘要、意图和 voiceAgent 四个模块均只依赖共享契约或纯 JavaScript 值，没有导入 DSH 包、读取运行时服务或访问会话存储。
  - 这一步到底做什么：确认四个纯逻辑模块（`assistant-scope`、`assistant-summary`、`assistant-intent`、`voice-agent`）不依赖 DSH 服务，可独立测试。
  - 做完你能看到什么：范围过滤、意图与摘要逻辑可以脱离运行时验证。
  - 先依赖什么：2.0、2.1、2.2、2.3。
  - 开始前先看：`design.md` §2.2。
  - 主要改哪里：模块导入边界与测试。
  - 这一步先不做什么：不为了测试方便把 DSH 服务塞进纯逻辑模块。
  - 怎么算完成：纯逻辑模块的测试不需要启动 DSH 运行时。
  - 怎么验证：`rg` 检查无 `@deepseek-ai`、`ctx.*`、`sessionQuery`、`sessionController` 依赖；四组专项测试均在构建产物上独立通过。

## 阶段 3：汇聚与派发接入

- [x] 3.0 受管范围设置界面
  - 状态：DONE
  - 证据：`src/host/features/assistant-scope-settings.ts` 与 `tests/assistant-scope-settings.spec.ts`。通过注入式设置存储实现默认空范围、显式勾选/取消、持久化和范围变更通知；真实 DSH 设置与 UI 接线留在集成层，未自动纳入任何工作区。
  - 这一步到底做什么：在设置中提供工作区勾选界面，列出 `ctx.workspaceRegistry` 的全部工作区（含未勾选的），持久化用户选择，并在变更时触发索引重建。
  - 做完你能看到什么：用户能在设置里勾选要管的工作区，重启后选择保留。
  - 先依赖什么：2.0。
  - 开始前先看：`design.md` §3.0.2；`requirements.md` 需求 8。
  - 主要改哪里：Client 侧设置面板；Host 侧范围持久化（`ctx.settings` 或等价机制）。
  - 这一步先不做什么：不写入 DSH 核心配置；不自动勾选任何工作区。
  - 怎么算完成：默认不纳入任何工作区；勾选与取消勾选都持久化；范围变更后索引立即重建；范围为空时界面明确提示。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/assistant-scope-settings.spec.ts` 通过（3/3）；`git diff --check` 通过。

- [x] 3.1 会话索引构建与刷新
  - 状态：DONE
  - 证据：`src/host/features/assistant-session-index.ts`、`src/host/features/assistant-summary.ts` 与 `tests/assistant-session-index.spec.ts`、`tests/assistant-summary.spec.ts`。索引构建先执行「受管工作区 ∩ 未归档」过滤，再调用注入的语义摘要读取；标题取最后一条有效 `session/title`；保留 Host、工作区、状态、活动时间、索引代次和 `unreadableCount`；单会话读取失败只计数，不中断整体结果，最终播报会明确说明有多少会话暂时无法读取且摘要可能不完整，长度受限时也保留这条提示。
  - 这一步到底做什么：接入 `ctx.sessionQuery.listSessions()` 取得会话全集，用 `ctx.workspaceRegistry` 过滤受管范围并排除 `archivedSessionIds`，订阅 `session/event` 做增量更新。
  - 做完你能看到什么：助理能拿到受管范围内、未归档的会话清单。
  - 先依赖什么：2.0、2.1、3.0。
  - 开始前先看：`design.md` §3.0–§3.3、§3.5；`requirements.md` 需求 1、2、8、9；`docs/20261004-会话汇聚与语音能力调查.md` §2、§3。
  - 主要改哪里：新增 `src/host/features/assistant-session-index.ts`；复用 `src/host/modules/peer-host/dsh-native-summary-source.ts` 已有结构。
  - 这一步先不做什么：不重复实现 PeerHost 通道；不自行读取会话存储文件；不遍历原始事件日志；不在插件加载时扫描（首次构建延后到用户首次询问）。
  - 怎么算完成：能处理 `listSessions()` 的 `{header,live,persisted}` 包装；标题取最后一条 `session/title`；排除全部归档会话；只包含受管工作区；无标题会话为 `null`；读取不激活冷会话；构建异步、不阻塞。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/assistant-session-index.spec.ts` 通过（4/4）；`git diff --check` 通过。真实 DSH 数据对照需后续在明确授权的 Stage0 测试中进行。

- [x] 3.1.1 归档状态变更响应
  - 状态：DONE
  - 证据：`AssistantSessionIndexController` 在归档集合变化时立即递增索引代次并重建；归档会话退出索引，取消归档重新纳入，输入会话记录不被修改。
  - 这一步到底做什么：订阅归档与取消归档事件，实时把会话移出或移回索引，并停止/恢复其更新订阅。
  - 做完你能看到什么：归档一个会话后它立刻从摘要消失，取消归档后立刻回来。
  - 先依赖什么：3.1。
  - 开始前先看：`design.md` §3.0.1；`requirements.md` 需求 9。
  - 主要改哪里：索引模块的事件订阅与测试。
  - 这一步先不做什么：不修改或删除归档会话的日志；不自动取消归档。
  - 怎么算完成：归档即退出索引；取消归档即重新纳入；已归档会话的历史记录不被触碰；读取不使其变为活跃。
  - 怎么验证：`node --test tests/assistant-session-index.spec.ts` 5/5 通过，覆盖归档和取消归档；实现不读取或写入会话日志文件。

- [x] 3.2 等待处理状态接入
  - 状态：DONE
  - 证据：`src/host/features/assistant-waiting-state.ts` 与 `tests/assistant-waiting-state.spec.ts`。等待状态只由审批/提问请求事件写入，并可由解决事件清除；索引条目通过 `waiting` 字段消费，不把 `running` 推断成等待。
  - 这一步到底做什么：从 `approval/request`、`user-questions/request`（Host）与 `ctx.uiSession.pendingInteractions`（Client）获取等待状态，写入索引。
  - 做完你能看到什么：摘要能优先报出「有东西在等你处理」。
  - 先依赖什么：3.1。
  - 开始前先看：`design.md` §3.4；`requirements.md` 需求 7；调查文档 §5.2、§8。
  - 主要改哪里：索引模块的 waiting 字段来源与测试。
  - 这一步先不做什么：不用 `running` 推断等待状态；不靠扫描历史日志推断等待（本机 `approval/asked` 仅 2 条，样本不足以代表当前状态）。
  - 怎么算完成：运行中但未等待的会话不被报成待处理；等待项在摘要中优先出现；等待状态来自运行时事件而非历史扫描。
  - 怎么验证：`node --test tests/assistant-waiting-state.spec.ts` 通过（1/1）；与摘要 2.1 的 waiting 优先级测试共同覆盖顺序。

- [x] 3.3 派发器
  - 状态：DONE
  - 证据：`src/host/features/assistant-dispatch.ts` 与 `tests/assistant-dispatch.spec.ts`。派发前重新校验目标存在、Host/工作区一致、索引代次、受管范围和归档集合；`queue`/`steer` 原样传给注入的 prompt；重复 `requestId` 不重复调用；范围外和归档目标拒绝且不自动取消归档。
  - 这一步到底做什么：实现目标解析后的投递，调用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content })`，处理错误与幂等，并在投递前校验目标在受管范围内且未归档。
  - 做完你能看到什么：一句「让 X 去做 Y」能把任务投到目标会话并回报结果。
  - 先依赖什么：2.2、3.0、3.1。
  - 开始前先看：`design.md` §5.3；`requirements.md` 需求 6、需求 8 验收标准 5–6、需求 9 验收标准 7。
  - 主要改哪里：新增 `src/host/features/assistant-dispatch.ts` 与测试。
  - 这一步先不做什么：不绕过 DSH 权限与审批边界；不新建跨 Host 派发通道；不向范围外或已归档会话投递；不自动取消归档。
  - 怎么算完成：`queue`/`steer` 选择正确；目标不存在时结构化错误；空任务被拒；重复 `requestId` 不重复插入；范围外目标被拒并提示加入范围的入口；已归档目标被拒并说明原因。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/assistant-dispatch.spec.ts` 通过（3/3）；`git diff --check` 通过。真实会话派发需后续获得明确 Stage0 授权后验证。

## 阶段 4：语音接入

- [x] 4.0 全局语音协调器与运行时适配边界
  - 状态：DONE
  - 证据：`src/shared/contracts/voice-runtime.ts`、`src/host/features/global-voice-coordinator.ts` 与 `tests/global-voice-coordinator.spec.ts`。运行时只通过适配器处理音频；协调器提供 Host 唯一麦克风租约、常开流式 PCM、唤醒状态、barge-in、epoch 丢弃迟到事件、心跳 TTL 自动释放和资源释放，完全不保存目标 `sessionId`。客户端租约使用页面实例 owner，并由 Host 按序接收状态事件。
  - 这一步到底做什么：定义 `VoiceRuntimeAdapter` 与 Host 级 `GlobalVoiceCoordinator`，实现全局会话、唯一麦克风租约、wake/listening/speaking/interrupt 状态、音频 epoch 和根级事件流。
  - 做完你能看到什么：语音上下文不再绑定当前 DSH 会话，多标签页不会同时占用麦克风，迟到音频帧不会污染新轮次。
  - 先依赖什么：2.3、3.1。
  - 开始前先看：`design.md` §2.1、§7；`docs/开发记录/20261005-spec013全局语音助理架构重审.md`。
  - 主要改哪里：`src/shared/contracts/voice-runtime.ts`、`src/host/features/global-voice-coordinator.ts` 及纯逻辑测试。
  - 这一步先不做什么：不改 Desktop，不绑定当前页面会话，不直接复制第三方插件 UI 或供应商方言。
  - 怎么算完成：fake runtime 覆盖常开麦克风、唤醒词、流式 PCM、barge-in、实时打断、epoch 丢帧、租约冲突和资源释放。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 通过；`node --test tests/global-voice-coordinator.spec.ts` 通过（4/4）；`git diff --check` 通过。真实设备验收留到获得明确 Stage0 授权后进行。

- [x] 4.1 客户端设备管理与成熟全双工运行时接入
  - 状态：DONE（真实浏览器设备验收保持 IN_REVIEW）
  - 证据：`src/client/sherpa-voice-adapter.ts`、`src/client/features/global-voice-assistant.ts`、`src/host/features/global-voice-rpc.ts` 和 `profile/package.json` 已接入 CodingNS 自有 PCM 数据面与按需 `sherpa-onnx-node`；Client 负责浏览器设备、权限、常开麦克风和 PCM 上传，Host 负责唯一租约、运行时加载、能力投影与动作 RPC；不接入 DSH `speechToText` 回退。
  - 这一步到底做什么：通过 CodingNS 自己的适配器接入 Sherpa-ONNX，不在 JSON RPC 中传连续 PCM；保留 Host 唯一租约、权限错误和能力降级边界。
  - 做完你能看到什么：用户在浏览器根级入口启用全局语音，Sherpa 负责本地识别，Host 负责索引、意图和动作；运行时不可用时显示明确错误并保留普通文字输入。
  - 先依赖什么：1.3、4.0。
  - 开始前先看：`design.md` §2.1、§7、§7.2、§7.3；`requirements.md` 需求 4、需求 10；调查文档 §6、§7。
  - 主要改哪里：`src/client/voice-device-manager.ts`、`src/client/voice-capture.ts`、`src/client/sherpa-voice-adapter.ts`、`src/client/features/global-voice-assistant.ts`、Host PCM 流路由和 `profile/package.json`。
  - 这一步先不做什么：不读取 Host 的物理麦克风，不绕过浏览器 HTTPS/权限，不把设备 ID上传为远端硬件标识，不复制第三方 UI 或供应商方言。
  - 怎么算完成：成熟运行时能力探测、浏览器设备、流式会话、唤醒词、barge-in、实时打断、权限错误、租约冲突和 epoch 丢帧都有适配器或 fake runtime 测试；运行时不可用时不报告 realtime 能力，不调用 DSH `speechToText`。
  - 怎么验证：`pnpm run build`、`pnpm run typecheck`、`tests/realtime-voice-adapter.spec.ts`、`tests/global-voice-coordinator.spec.ts`；真实设备仍需明确授权的 HTTPS 局域网 Stage0 验收。

- [x] 4.4 语音提供商与模型初始化配置
  - 状态：DONE（真实 Host 模型加载保持 IN_REVIEW）
  - 证据：`AssistantVoiceSettings` 与 Host Settings Schema 持久化运行时、初始化状态和 Sherpa ASR/VAD/TTS 模型路径；`VoiceInitializationDialog` 提供首次配置和重新配置入口；全局助手按钮在未初始化或 Sherpa ASR 路径不完整时只打开配置页，不调用 `assistant/voice/start`；Host RPC 在启动前再次校验配置。
  - 这一步到底做什么：消除“点击按钮即加载模型”的错误特殊情况，把提供商选择、模型路径校验和运行时启动拆成两个明确阶段。
  - 做完你能看到什么：首次点击助手只看到初始化页；选择推荐的 Sherpa-ONNX 实时模型并完成模型准备后才允许启动。
  - 先依赖什么：4.1、4.2。
  - 主要改哪里：`src/shared/contracts/config.ts`、`src/host/settings.ts`、`src/host/features/global-voice-rpc.ts`、`src/client/features/voice-initialization-dialog.ts`。
  - 怎么验证：新语音文件过滤类型检查无错误；`pnpm run i18n:check`、`pnpm run version:check`、`pnpm run capability:check`、`git diff --check` 通过；真实模型路径和浏览器设备仍需在构建产物刷新后验收。

- [x] 4.1.1 浏览器设备选择器与状态入口
  - 状态：DONE（真实设备验收保持 IN_REVIEW）
  - 证据：`assistant-panel.ts` 使用 Client 适配器展示输入设备选择，并在浏览器确有 `setSinkId()` 能力时展示输出设备选择；选择只保存于当前浏览器来源，适配器在启动时重新枚举并验证，监听设备变化和音轨结束；根级入口提供语音状态、录音提示、租约冲突、空/无效转写和安全错误。
  - 这一步到底做什么：在全局智能助理设置面板展示 Client 输入设备状态与选择，适配器将选择传给浏览器 `getUserMedia` 约束；根级入口展示输入状态、权限错误、租约占用和安全上下文提示。
  - 做完你能看到什么：用户从全局入口直接管理浏览器设备；没有权限或不是 HTTPS 时能直接看到原因。
  - 先依赖什么：4.0、4.1。
  - 开始前先看：`design.md` §7.3；`requirements.md` 需求 10。
  - 主要改哪里：Client 全局语音入口与 Sherpa 运行时适配器。
  - 这一步先不做什么：不伪造 `speechSynthesis` 的输出设备选择；不让设备管理器读取会话内容。
  - 怎么算完成：录音状态、权限错误、租约冲突和恢复动作可见；运行时设备切换不会影响当前会话索引与键盘输入。
  - 怎么验证：适配器测试覆盖不可用环境、授权失败和释放；真实 HTTPS 页面验收留到 Stage0。

- [x] 4.2 语音播报接入
  - 状态：DONE（真实设备验收保持 IN_REVIEW）
  - 证据：`src/client/sherpa-voice-adapter.ts` 使用浏览器 `speechSynthesis` 按句播报并按 epoch 中断旧播放；`src/client/voice-output.ts` 覆盖降级路径；没有真正下行流时不报告 `streamingOutput`。
  - 这一步到底做什么：通过浏览器句级 TTS 按句、可中断播报；不可用时回退为文字提示。
  - 做完你能看到什么：问进展后能听到摘要。
  - 先依赖什么：2.1、4.0、4.1。
  - 开始前先看：`design.md` §4.2、§7.3、§10 开放问题 1。
  - 主要改哪里：`src/client/voice-output.ts`、`src/client/sherpa-voice-adapter.ts` 与浏览器输出设备适配。
  - 这一步先不做什么：不把播报绑定到当前 DSH 会话；不把按句播报宣称为流式输出。
  - 怎么算完成：播报文本无 Markdown/URL；按句播放期间可停止；TTS 不可用时降级为文字；能力报告正确标记非 streaming output。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit`、`pnpm run build`、`node --test tests/voice-output.spec.ts tests/sherpa-voice-runtime.spec.ts`；真实播报需后续 Stage0 授权。

- [x] 4.3 动作注册与意图闭环
  - 状态：DONE
  - 证据：`src/host/features/voice-agent-actions.ts` 已注册汇总/派发动作和 `assistant_command`；成熟 voiceAgent 的 final 文本经 Client 适配器和 Host RPC 进入意图、索引与派发链路；真实设备仍需验收。
  - 这一步到底做什么：把汇总与派发注册为 `voiceAgent` 动作，串起「转写 → 意图 → 动作 → 播报」完整链路。
  - 做完你能看到什么：说「现在进展怎么样」听到摘要；说「让 X 去做 Y」完成派发并回报。
  - 先依赖什么：2.3、3.3、4.0、4.1、4.1.1、4.2。
  - 开始前先看：`design.md` §2.1、§6；`requirements.md` 需求 5、6。
  - 主要改哪里：`src/host/features/voice-agent-actions.ts`。
  - 这一步先不做什么：不把意图逻辑写进语音服务内部。
  - 怎么算完成：两条主路径的动作、范围复核、目标澄清和播报结果均已接通；目标不唯一时反问。
  - 怎么验证：`pnpm exec tsc -p tsconfig.json --noEmit`、`pnpm run build`、`node --test tests/assistant-voice-turn.spec.ts tests/assistant-voice-actions.spec.ts tests/voice-stream.spec.ts`；真实 HTTPS Web 设备端到端需后续 Stage0。

## 阶段 5：验证与文档

- [x] 5.1 契约对照检查
  - 状态：DONE
  - 证据：`src/host/features/voice-agent-service.ts` 已按历史调查文档对照实现方法名、事件路径、owner 前缀匹配、后注册优先、超时和错误文案；`global-voice-rpc.ts` 将该实现注册为 Host Context 的 `voiceAgent` 服务，并在功能停用时释放注册；Host 业务动作保持独立，Sherpa 只能通过 `VoiceRuntimeAdapter` 接入。
  - 这一步到底做什么：把复刻实现与 `docs/20261004-voiceAgent服务契约调查.md` 逐条对照。
  - 做完你能看到什么：确认契约面一致，或明确列出有意差异。
  - 先依赖什么：2.3。
  - 开始前先看：`design.md` §6.2、§6.3；`requirements.md` 需求 5 验收标准 9、10。
  - 主要改哪里：调查文档补充对照结论。
  - 这一步先不做什么：不为了「看起来一致」而模仿参考实现里我们不需要的部分。
  - 怎么算完成：方法名、事件名、owner 匹配、超时语义逐条有结论；差异有理由。
  - 怎么验证：`tests/voice-agent-service.spec.ts` 5/5 通过，覆盖 owner 假值、后注册优先、未知动作、参数错误、幂等 resolve、递归截断和自动 action-result。

- [ ] 5.2 完整验证与实现记录
  - 状态：IN_REVIEW
  - 证据：`pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm run check:dsh-matrix`、`pnpm run i18n:check`、`git diff --check` 均通过；完整 `pnpm test` 通过 1353/1353。新增测试覆盖 Host `voiceAgent` 服务注册与释放、成熟运行时适配器、动作桥、范围/归档过滤和全局租约；真实浏览器麦克风、设备权限、HTTPS/WSS、扬声器和 barge-in 仍需在明确授权的 Stage0 设备上验收，因此本任务保持 IN_REVIEW。
  - 这一步到底做什么：运行项目要求的检查并记录结果，包含范围过滤与归档过滤的专项验证。
  - 做完你能看到什么：实现、测试、调查证据和任务状态相互对应。
  - 先依赖什么：3.0、3.1、3.1.1、3.2、3.3、4.3、5.1。
  - 开始前先看：`design.md` §8。
  - 主要改哪里：`docs/开发记录/` 新增实现记录；本文件回写证据。
  - 这一步先不做什么：不在测试未通过时把状态写成 DONE。
  - 怎么算完成：`pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 与完整 `pnpm test` 通过；新增测试全部通过；范围过滤、归档过滤、性能指标三项专项验证有实测数据。
  - 怎么验证：上述命令的实际输出，记录通过数量；性能验证记录实际耗时（索引构建应 < 1.5 秒）。

- [x] 5.3 更新 Spec 索引
  - 状态：DONE
  - 证据：根目录 `AGENTS.md` 已补充 Desktop 端绝对隔离规则；Spec 索引已包含 spec013 的 README、requirements、design、tasks；新增开发记录 `docs/开发记录/20261005-spec013全局语音助理架构重审.md` 和插件目录隔离记录均已登记。`AGENTS.md` 按仓库约定为本地协作文件，不进入 Git。
  - 这一步到底做什么：把 spec013 加进根目录 `AGENTS.md` 的 Spec 索引，并登记新增开发记录。
  - 做完你能看到什么：从 `AGENTS.md` 能直接跳到本 Spec 的四份文档。
  - 先依赖什么：5.2。
  - 开始前先看：`AGENTS.md` 的「Spec 索引」与「文档索引与新增文档规则」。
  - 主要改哪里：`AGENTS.md`。
  - 这一步先不做什么：不顺手改动其它 Spec 的索引条目。
  - 怎么算完成：README、requirements、design、tasks 四条链接可跳转；开发记录已登记。
  - 怎么验证：点击链接检查；`git diff` 确认只增不改无关行。

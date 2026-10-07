# 任务清单 - 编程助理语音汇聚与实时对话

状态：阶段 1、阶段 2、阶段 3、阶段 4.0、4.1、4.1.1、4.2、4.3、4.4、4.5、4.6、4.7、4.8、4.9 已完成；阶段 5.2 IN_REVIEW（等待真实 HTTPS Web 设备验收）；阶段 5.3 已完成。

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
  - 这一步到底做什么：优先读取 `ctx.sessionController.list()` 的原生会话投影，按 `ctx.workspaceRegistry` 成员关系过滤受管范围，并排除子代理、空白占位及 `archivedSessionIds`；缺少原生列表能力时兼容历史查询包装。成员口径修复见4.10。
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

- [x] 4.5 浏览器请求流上传兼容修复（2026-10-07）
  - 状态：DONE（真机 HTTPS 对话验收仍保持 IN_REVIEW）
  - 证据：Client 改用短批次二进制 POST 和独立 GET 事件下行；Host 沿用单个 Sherpa 识别器，校验 owner、epoch、批次大小与完整性；客户端上传积压与请求超时有界，断线后停止采集并释放租约。
  - 附带修复：Host epoch 同步、重复打断、播报阻塞 partial、启动未返回就关闭时的租约清理，以及事件连接状态回声和静音保活。独立登记 buffered GET `/events` 和 streaming POST `/stream`，修复 DSH 原生 HTTP 桥给 GET 附加正文导致的 HTTP 400。
  - 验证：源码加载器执行语音、智能助理、契约和模块接线相关测试 108/108 通过，`pnpm run typecheck`、`pnpm run i18n:check`、`git diff --check` 通过。新增原生 HTTP 桥回归，复现旧配置错误并验证 GET 200、POST 204、实时文字下发与租约保护。不执行构建，不启动或重启 Stage0，不操作 Desktop。
  - 开发记录：`docs/开发记录/20261007-实时语音浏览器请求流上传兼容修复记录.md`。

- [x] 4.6 中文 Large 模型与独立全局管理调试（2026-10-07）
  - 状态：DONE（新入口尚需加载最新产物，真机准确率由用户联调）
  - 用户边界：仅切换指定模型并增加完整状态调试按钮/模态框；暂不补全助理消息，不接入 LLM，不重设计对话界面。
  - 模型：目录首选中文 Zipformer Large（2025-06-30），保留旧模型 ID；按官方发布文件使用 `encoder.int8.onnx`、`decoder.onnx`、`joiner.int8.onnx`、`tokens.txt`。下载到 `/Users/jackson/.dsh-stage0-020/codingns4dsh/voice-models/`，原生加载及公开中文测试音频识别通过后，更新 Stage0 专用 `cordis.patch.yml` 的模型 ID 和四个路径。
  - 调试：助理窗口与设置页均可进入独立模态框；无语音租约、未初始化模型也可读取状态。支持工作区勾选、强制刷新、全部纳入/排除记录、运行/完成/错误/未知/等待状态、正文摘要、服务接入与读取诊断、完整汇总、JSON 查看和下载，以及文字意图预览/执行。
  - 范围：保留范围外/归档元数据用于诊断，不读取其正文或额外标题；远端读取失败与缺失工作区归属可见。索引代次持续递增；文字执行复用原有派发校验和去重，预览无派发副作用。
  - 验证：源码加载器执行语音、智能助理、契约与模块接线相关测试 114/114 通过；类型、版本、能力、国际化检查及 `git diff --check` 通过。未执行构建，未启动/重启 Stage0，未操作 Desktop，未提交或推送。
  - 开发记录：`docs/开发记录/20261007-中文Large模型切换与全局助理状态调试记录.md`。

- [x] 4.7 模型下载进度条（2026-10-07）
  - 状态：DONE（实际页面需加载更新后的 Host 与 Client 产物）
  - 实现：Host 按实际写入字节回报当前文件进度，Client 显示进度条、文件序号、文件名、百分比和下载大小；未知大小使用不定进度条。下载结束后单独显示初始化阶段；请求 ID 隔离查询，初始化期间禁止重复下载或启动语音，关闭或结束后清理查询。
  - 兼容：可选下载进度回调和旧初始化载荷保持兼容，沿用模型白名单、缓存复用与临时文件改名；新查询端点同时登记浏览器主通道及旧 HTTP 精确入口。
  - 验证：相关源码回归 125/125 通过；随后新增旧 HTTP 入口回归，定向测试 3/3 通过。最终类型、国际化和差异格式检查通过；未构建或启停服务，未操作 Desktop。
  - 开发记录：`docs/开发记录/20261007-语音模型下载进度条实现记录.md`。

- [x] 4.8 五步索引调试与 LLM 文本问答（2026-10-07）
  - 状态：DONE（真实模型服务与界面交互效果待用户加载最新产物后联调）
  - 用户确认：复用 DSH 已配置模型，先做只读索引问答，不派发任务。
  - 面板：范围设置、范围内工作区/会话、当前索引结果、索引记录、LLM 文本对话五个入口；刷新面板不触发正文读取，执行索引保存最近 30 次运行记录，底层信息收进高级诊断。
  - 数据：修正 v4 助理嵌套正文、运行时上下文与思考块过滤；补充可靠运行状态和更新时间，两个汇总入口都保留未知状态；范围改变不返回旧正文，构建期间源数据变化标记过期。
  - LLM：集中式 `llm.text` 适配器复用宿主模型目录、默认模型与流式调用；支持多轮、增量文字、停止与超时，限制历史和事实大小。未建或过期索引拒绝调用，异步目录读取后再次校验，释放模块取消生成。
  - 兼容：主通道与旧 HTTP 入口均登记索引和文字对话端点；保留既有规则预览/执行与语音动作，问答不创建 Agent、项目会话或工具。
  - 验证：相关源码回归 163/163 通过；最终 LLM/调试定向回归 19/19 通过。原生 DSH 0.2.1-alpha.1 内存运行时验证通过，未发送实际模型请求；类型、国际化、能力、依赖矩阵、版本和差异格式检查通过。未构建或启停服务，未操作 Desktop，未提交或推送。
  - 开发记录：`docs/开发记录/20261007-全局助理五步索引调试与LLM文本问答记录.md`。

- [x] 4.9 语音模型管理与可用性验证（2026-10-07）
  - 状态：DONE（真实模型与实际页面视觉验收待加载最新 Host、Client 产物后完成）
  - 文件状态：只读查询区分未下载、文件不完整、已下载、当前配置及最近验证结果；保留当前自定义路径，文件变化使持久验证记录失效。
  - 验证：独立 Node 子进程使用正式识别配置加载四个文件，执行两秒静音解码，隔离原生异常退出；支持超时与模块释放取消，无需麦克风或语音租约。切换通过验证后才保存配置，修复先验证整组临时文件再替换旧缓存。
  - 界面：模型卡片、文件详情与位置、刷新、验证、补全下载、切换与重新下载；下载和验证阶段分开显示，操作成功保留窗口。实时运行禁止切换与修复，另一页面操作时自动刷新。
  - 回归：相关源码测试 96/96 通过，类型、国际化及差异格式检查通过。浏览器本地文件预览被策略拒绝，未构建或启停服务，未操作 Desktop。
  - 开发记录：`docs/开发记录/20261007-语音模型管理与可用性验证实现记录.md`。

- [x] 4.10 工作区会话可见性与归档子会话过滤（2026-10-07）
  - 状态：DONE（Stage0 实际页面待加载最新 Host 产物后验收）
  - 原因：TEST 的49条由2个普通会话、3个空白占位和44个归档父会话的子代理组成；按 `cwd` 推断成员导致子代理进入索引。
  - 修改：原生列表提供 `blank/origin`，本地归属只认工作区成员；列表为空或失败不回退全量历史。归档元数据按成员与全局集合交集补齐，当前成员变化后不返回旧索引正文，独立分叉保持兼容。
  - 验证：实际 Stage0 元数据只读回放得到2个普通会话与103个归档排除；相关源码回归173/173通过，类型与差异格式检查通过。国际化守卫被本次未修改的 PeerHost 日志文案阻断。未构建、启停服务或操作 Desktop。
  - 开发记录：`docs/开发记录/20261007-全局助理工作区会话可见性修复记录.md`。

- [x] 4.11 手动索引 LLM 总结与可编辑口语提示词（2026-10-07）
  - 状态：DONE（实际模型输出质量待加载最新 Host/Client 产物后联调）
  - 用户确认：手动索引保留原始摘录，额外调用所选 LLM 总结进展、阻碍与下一步；两套前置提示词在调试面板独立编辑，默认简洁口语化。
  - 实现：顶部共用模型选择；正文索引立即返回，后台模型生成支持轮询与停止。来源摘录和模型总结分别保存，模型推断不覆盖真实状态；刷新和自动按需索引不增加模型调用，失败不冒充成功。
  - 设置：提示词单字段持久化、8000字符上限、缺省/清空回填、只读/版本策略。改索引提示词使结果过期，改对话提示词只重开对话。默认短句，禁止标题、编号、列表、表格、Markdown、排比及重复铺陈；未知和建议必须明确说明。
  - 验证：定向29/29、最终相关源码263/263通过，类型与差异格式检查通过。国际化守卫仅被本次未修改的 PeerHost 日志文案阻断。未调用真实模型、未构建或启停服务，未操作 Desktop。
  - 开发记录：`docs/开发记录/20261007-全局助理LLM索引总结与口语提示词实现记录.md`。

- [x] 4.12 逐会话结构化索引与严格结果校验（2026-10-07）
  - 状态：DONE（实际 DeepSeek 输出质量待最新 Host/Client 加载后重新索引验证）
  - 原因：用户最新快照已成功调用模型，但整段播报没有可稳定检索的目标、事实、任务和证据，不利于后续问答。
  - 格式：固定 JSON 版本与会话完整覆盖，逐会话保留目标、进展、阻碍、已提出待办、下一步行动和信息缺口。事实与行动附原文证据，行动区分已有任务/建议及优先级、理由；Host 填入真实身份、运行状态与时间。
  - 校验与问答：完成前校验字段、范围、原文引用与长度；非法结果为失败/不完整，不进入问答。LLM 对话按结构定位与分析，最终回复仍用简短口语；播报不朗读 JSON。来源材料和模型结果独立，记录不保存结构化正文。
  - 面板与兼容：按会话展示六类信息，证据可展开，未校验流式原文收进诊断。固定结构优先于旧整段播报提示词；两套前置提示词仍可编辑，字段内保持口语表达。
  - 验证：定向33/33、最终相关源码267/267通过；类型与差异格式检查通过。国际化守卫只剩本次未修改的 `src/client/features/peer-host.ts:96` 日志文案阻断，本次新增词条中英文一致。未调用真实模型、未构建或启停服务，未操作 dsh-web/ Desktop，未提交或推送。
  - 开发记录：`docs/开发记录/20261007-全局助理结构化索引格式与校验记录.md`。

- [x] 4.13 逐会话独立索引任务与关闭模型思考（2026-10-07）
  - 状态：DONE（真实模型耗时与输出质量待最新 Host/Client 加载后联调）
  - 原因：三个会话共用结构化索引请求达到回复上限；按用户要求拆分请求，消除会话数量与单次输出预算的耦合。
  - 实现：专用 `AssistantIndexAnalysis` 每会话独立请求、取消信号、8192 token预算、校验、增量和90秒超时，最多两个并发，不受聊天30轮容量限制。单项失败不阻断其余任务，成功项持续保留；有失败的批次保持不完整，不冒充完整索引进入问答。
  - 思考参数：读取 DSH 原生模型能力，只在支持时发送 `reasoningEffort: "off"` 或 `"none"`。调试页和记录显示实际传参状态，普通文字对话不受影响。真实安装的 DeepSeek 适配器内存拦截验证将 `off` 转成 `thinking.type=disabled`，未发送网络请求。
  - 生命周期：目录阶段与单项均可超时结算；停止和范围、来源、提示词变化取消排队及运行任务，目录与能力读取后复核来源，晚到结果不污染新代次。
  - 验证：定向42/42、整体相关源码279/279通过，类型与差异格式检查通过。国际化守卫仍被既有 `src/client/features/peer-host.ts:96` 日志文案阻断，本次新增词条中英文一致。未调用真实模型、未构建或启停服务，未操作 dsh-web/Desktop，未提交或推送。
  - 开发记录：`docs/开发记录/20261007-逐会话独立索引与关闭模型思考实现记录.md`。

- [x] 4.14 会话完成后自动增量索引（2026-10-07）
  - 状态：DONE（真实 Host/Client 加载后的事件与模型联调待验证）
  - 用户要求：按会话记录版本，只标记受管范围内发生有效变化的会话；一轮结束后合并更新，复用其他结果；模型、索引提示词或固定格式变化才全量重建。明确禁止在会话执行中触发。
  - 实现：`AssistantIndexUpdates` 保存逐会话来源、已索引和已尝试版本；原生语义事件及元数据驱动变化，结束后延迟5秒合并，有效变化重新计时，普通刷新与无变化通知不推迟已有任务。原生 Agent 或外部适配器执行结束才放行，`step/end`、刷新及未知状态不放行；手动同样遵守。运行期间不提取新正文，不调用索引模型。
  - 复用：来源版本缓存材料，模型/提示词/格式/实际材料摘要识别结果；工作区增删与归档只调整成员，公共成员继续复用。新轮次只取消对应任务；失败版本不随轮询或其他会话更新自动重试，手动可重试。
  - 远端：每5秒读取元数据；独立活动状态保留未知，真实请求前重新确认空闲和版本，不使用侧栏默认 `idle` 冒充完成。
  - 调试：后台更新不依赖窗口，模型配置端点兼容两种 RPC 入口；显示来源/索引版本、复用与等待状态。缓存属于 Host 内存，重启后重新建立基线；仍是逐会话有界摘录，不宣称完整历史增量数据库。
  - 验证：定向源码72/72通过；增量代码完成时类型检查通过，收尾检查被当前形象模块 `assistant-avatar-runtime.ts:77` 的 TS2532 阻断。国际化词典键一致，守卫仍被既有 PeerHost 导航日志阻断；扩大回归发现另一路 TTS 精确路由校验失败，以上无关改动未混改。未调用真实模型、未构建或启停服务、未操作 dsh-web/Desktop、未提交或推送。
  - 开发记录：`docs/开发记录/20261007-会话完成后自动增量索引实现记录.md`。本项替代4.11中的手动模型总结触发规则。
  - 后续调整：按用户反馈改为结束后等待5秒，有效变化重新计时；普通刷新、无变化轮询、日志刷新和重复空闲通知不延长已有等待。增量、调试与独立任务38/38、当前类型检查及差异格式检查通过；未构建或启停服务。

- [x] 4.15 助理回复收紧为短句与重点动作（2026-10-07）
  - 状态：DONE（实际模型表达质量待加载源码后验证）
  - 用户反馈：问“哪些会话需要我处理”得到长段背景、多个附加建议和重复状态说明，重点不突出。
  - 实现：默认一到两个短句、100字以内；Host 在事实材料后追加重点规则，先给结论和必要动作，明确需要用户介入的事项优先。背景、其他会话、通用说明和支线建议不主动展开；用户明确要求全部、细节或证据时再展开。来源和建议边界继续保留。
  - 兼容：读取时只升级完整匹配的旧默认对话提示词，不写入原对象，真正自定义提示词保留；不改变索引提示词、格式、输出预算或结果缓存，不通过裁剪隐藏模型内容。
  - 验证：提示词、文字聊天、调试、结构校验与自动增量源码49/49、类型检查和差异格式检查通过；未调用真实模型、未构建或启停服务、未操作 dsh-web/Desktop、未提交或推送。
  - 开发记录：`docs/开发记录/20261007-全局助理简短回复与重点提示词调整记录.md`。

- [x] 4.16 实时语音接入 LLM 多轮对话与简短回复（2026-10-07）
  - 状态：DONE（真实设备与真实模型效果继续由5.2验收）
  - 实现：最终语音话语复用结构化索引门禁、原生 LLM 和短回复系统提示词；Host 保存有界完成问答历史，客户端轮询回显助理正文，完成后使用当前音色播报。
  - 生命周期：清空、停止和租约丢失清除历史；打断取消当前生成并保留完成历史。索引版本、模型、范围或对话提示词变化重置上下文。新话语、过期 epoch、乱序和取消先到的迟到请求均隔离。
  - 兼容：显式文字派发与动作注册保留；旧语音文本端点也进入 LLM。PCM／识别不被生成或播报阻塞；不可用时不回退关键词或 DSH 转写。
  - 验证：语音、文字 LLM、索引、增量、原生 HTTP 桥及 TTS 定向源码回归97/97通过；最后新增错误分支后客户端10/10通过。类型检查和差异格式检查通过。未构建、启停服务或操作 dsh-web／Desktop，未调用真实模型与麦克风，未提交。
  - 开发记录：`docs/开发记录/20261007-实时语音接入LLM多轮对话与简短回复记录.md`。

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
## 20261007 扩展任务：管理 Agent 与逐句流式播报

- [x] MG.1 接入独立管理根 Agent
  - 状态：DONE
  - 做什么：新增能力路由和兼容适配器，正式文字／语音共用原生 Agent；设置作用域提示词、只读沙箱、工具屏蔽及执行白名单、助理独立关闭思考与轮次上限。
  - 可见结果：一轮可多次查询并生成短答，其他会话保持原参数，连续历史继续保存。
  - 证据：适配器定向测试 6/6；已安装 DSH 的纯内存原生 Agent Loop 和工具校验器验证 2/2，通过真实工具执行续跑、禁止工具拒绝与其他根 Agent 参数隔离。
  - 边界：不创建子 Agent、不开放代码及命令工具、不使用另一套 Profile，不启动服务。
- [x] MG.2 接入范围校验与会话跟进
  - 状态：DONE
  - 做什么：四个专属管理工具，按当前范围读取，发送前校验完整目标及来源版本，排队去重并转发取消信号。
  - 可见结果：可查询会话并发送管理跟进，送达与完成分别报告。
  - 证据：工具定向测试 4/4；正式文字与语音 RPC 同一管理根 Agent 的联通测试通过，覆盖索引缺失仍查询及实际排队发送、来源不可用诊断；本地原生请求只传标准字段。
  - 边界：不自动新增编码任务，不变更目标会话自身的模型或权限。
- [x] MG.3 逐句消费流式文本并播放 TTS
  - 状态：DONE
  - 做什么：累计文字分句、串行有界播放、残句补播与重复快照去重，停止或新话语取消整条声音队列。
  - 可见结果：第一句在模型结束前开始播放，模型文字继续更新，MOSS 与浏览器保留当前参数。
  - 证据：队列测试 5/5；Client 与队列最终回归 18/18，覆盖实际 MOSS 输出入口、慢播报不中断轮询、停止丢弃待播句子及结算移除末尾换行不重复播报。
  - 边界：不把推理、工具参数或结果当作回复，不添加新的 TTS 引擎或下载动作。
- [x] MG.4 完成合并回归与文档检查
  - 状态：DONE
  - 做什么：合并回归共享历史、索引、声音、取消、RPC 与能力注册；回写文档和生成报告。
  - 证据：合并源码回归 177/177 通过；补充八文件回归 78/78、最终管理与 RPC 回归 25/25、Client 与队列回归 18/18 通过；类型、能力退休和差异检查通过，能力报告已重新生成。原生核心测试本机实际执行，未跳过。
  - 边界：真实设备验收仍保持原 IN_REVIEW；不构建、启停 Stage0、不触碰 Desktop，不提交发布。

- [x] TTS.10 Windows 语音环境兼容修复
  - 状态：DONE
  - 做什么：统一 Python UTF-8 管道和环境隔离、固定 Windows 系统解压器、下载模型前检查推理依赖，并等待旧工作进程关闭后再重试或初始化。
  - 兼容：保留现有音色、参数和缓存；Windows 本地 MOSS 支持范围仍为 x64；缺失运行库仅提示，不自动修改系统。
  - 验证：混合大小写环境变量、中文文本／路径／错误、分块解码、依赖失败重试及旧进程释放时序；Windows 实机验收继续由 TTS.4 跟踪。
  - 证据：直接相关测试 24 项、69 个文件的扩展源码回归、新增延迟关闭测试、类型检查及 Python 生成控制 4/4 通过；未构建或操作 Desktop。详见 `docs/开发记录/20261007-全局助理Windows兼容修复记录.md`。

- [x] ASR.1 语音同音词理解与领域热词
  - 状态：DONE
  - 做什么：仅为语音轮次追加 ASR 来源与同音词理解规则，结合有效索引和连续历史理解；保留原始转写，真实绘画话题及标题不做全局替换，目标歧义继续澄清。
  - 识别：切换改进束搜索，保留束宽 4 和句尾设置；最多 64 条领域词、受管工作区名及最近非归档会话标题。名称读取设 1.5 秒上限，超时使用领域词；中文／英文按兼容词表编码，私有临时词表构造后清理。
  - 证据：十文件源码回归 104/104、类型和脚本检查通过；按用户选择对同一批 18 段合成音频执行三组原生识别回放，会话词面命中由 0/12 到 3/12，纯绘画误识别为会话为 0/4。
  - 边界：热词改善有限，ASR 词面命中不等于真实 LLM 会话定位成功；未主动构建、启停 Stage0、修改模型选择或操作 Desktop。真实录音、在线语义及端到端延迟仍由实际使用验收确认。详见 `docs/开发记录/20261007-语音同音词理解与领域热词优化记录.md`。

# 任务清单 - 编程助理语音汇聚与实时对话

状态：阶段 1 已完成；阶段 2 起待开始

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
  - 这一步先不做什么：不安装该插件，不把它加进依赖。
  - 怎么算完成：契约清单覆盖 `capabilities`、`startConversation`、`registerActions`、会话句柄方法、9 种事件、超时与 owner 匹配规则、错误文案；并记录契约文件与代码不一致之处。
  - 怎么验证：`npm view dsh-realtime-voice dist.tarball` 取包解压，对照文件逐条核对；文档中标注「已核实」与「仅 README 声称」。

- [x] 1.2 确认 DSH 核心会话查询与语音能力边界
  - 状态：DONE
  - 证据：`docs/20261004-会话汇聚与语音能力调查.md`。实测本机 542 个唯一会话（650 个格式文件，47 个会话多格式并存）/ 552,246 事件 / 334.8 MB，全量读取 4.59 秒；确认 `listSessions()` 返回 `{header,live,persisted}` 包装；确认 `SessionHeader` 不含 `title`/`workspaceId`；确认标题来自日志最后一条 `session/title`；确认 59 个游离会话；确认三种存储格式并存；确认 `approval/asked` 事件存在；确认核心无 TTS。
  - 这一步到底做什么：确认 `ctx.sessionQuery` 各方法在本机可用、返回结构、`readSurface` 的返回形态、`ctx.speechToText` 的 provider 接口、会话存储格式与读取成本，以及等待审批状态的正确来源。
  - 做完你能看到什么：知道哪些能力直接可用、哪些需要降级、哪些不可用，以及索引的真实数据来源。
  - 先依赖什么：无。
  - 开始前先看：`design.md` §3、§7；`requirements.md` 需求 1、2、4、7。
  - 主要改哪里：只新增 `docs/20261004-会话汇聚与语音能力调查.md`。
  - 这一步先不做什么：不修改 DSH 核心，不新增依赖，不安装插件。
  - 怎么算完成：索引数据来源、读取成本量级、等待处理状态来源、STT provider 接口、存储格式版本均有结论。
  - 怎么验证：在本机 DSH 0.2.0-rc.2 上做只读探测与真实数据实测；记录实际观察值与耗时。

## 阶段 2：纯逻辑模块

- [ ] 2.1 会话索引数据结构与摘要逻辑
  - 状态：TODO
  - 这一步到底做什么：实现 `SessionIndexEntry` 结构与 `assistant-summary` 纯逻辑，包括优先级压缩、空类目说明、敏感字段过滤、播报文本净化。
  - 做完你能看到什么：给定一份索引快照，能得到一段可直接朗读的摘要文本。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §3.2、§4；`requirements.md` 需求 3、需求 7。
  - 主要改哪里：新增 `src/shared/contracts/assistant.ts` 与 `src/host/features/assistant-summary.ts`（或等价位置）、对应测试。
  - 这一步先不做什么：不接真实数据源，不调模型。
  - 怎么算完成：优先级顺序正确；某类为空时摘要明确说明；文本不含 Markdown、URL、代码块；敏感形态字符串被过滤。
  - 怎么验证：纯逻辑单元测试。

- [ ] 2.2 意图解析与目标定位
  - 状态：TODO
  - 这一步到底做什么：实现 `assistant-intent` 纯逻辑：意图分类、目标解析四级匹配、多候选澄清判定、派发模式选择。
  - 做完你能看到什么：给一句话和一份索引，得到意图、目标会话或澄清请求。
  - 先依赖什么：2.1。
  - 开始前先看：`design.md` §5；`requirements.md` 需求 6。
  - 主要改哪里：新增 `src/host/features/assistant-intent.ts` 与测试。
  - 这一步先不做什么：不调用模型做意图分类（第一版用规则），不做真实投递。
  - 怎么算完成：精确/包含/序数/最近四级匹配各自有测试；多候选时返回澄清而不是猜测；`steer` 只在明确要求时选择。
  - 怎么验证：纯逻辑单元测试，覆盖多候选与歧义用例。

- [ ] 2.3 voiceAgent 服务与动作注册表
  - 状态：TODO
  - 这一步到底做什么：实现 `voiceAgent` 服务的契约面与动作注册表：`execute` 校验、`dispose` 语义、owner 前缀匹配、后注册者优先、未注册动作报错、超时结算、`action-result` 事件、`control.resolve` 幂等结算。
  - 做完你能看到什么：第三方代码可以注册动作，并得到与参考实现一致的行为。
  - 先依赖什么：1.1。
  - 开始前先看：`design.md` §6.3、§6.3.1；`requirements.md` 需求 5；`docs/20261004-voiceAgent服务契约调查.md` §5。
  - 主要改哪里：新增 `src/host/features/voice-agent-service.ts` 与测试。
  - 这一步先不做什么：不接任何具体语音供应商，不实现 barge-in，不照搬供应商特有的方言处理。
  - 怎么算完成：`design.md` §6.3 列出的 11 条保真行为逐条有测试；错误文案逐字一致；`capabilities()` 不声称未实现的能力。
  - 怎么验证：单元测试覆盖：假值 ownerId 静默、后注册者优先、`dispose` 幂等、未知动作与参数错误的文案、超时结算、4000 字符递归截断、`control.resolve` 返回 boolean 且幂等。

### 阶段检查 2.4

- [ ] 2.4 纯逻辑层复查
  - 状态：TODO
  - 这一步到底做什么：确认三个纯逻辑模块不依赖 DSH 服务，可独立测试。
  - 做完你能看到什么：意图与摘要逻辑可以脱离运行时验证。
  - 先依赖什么：2.1、2.2、2.3。
  - 开始前先看：`design.md` §2.2。
  - 主要改哪里：模块导入边界与测试。
  - 这一步先不做什么：不为了测试方便把 DSH 服务塞进纯逻辑模块。
  - 怎么算完成：纯逻辑模块的测试不需要启动 DSH 运行时。
  - 怎么验证：测试在无 DSH 环境下可运行。

## 阶段 3：汇聚与派发接入

- [ ] 3.1 会话索引构建与刷新
  - 状态：TODO
  - 这一步到底做什么：接入 `ctx.sessionQuery.listSessions()` 取得会话全集，用 `ctx.workspaceRegistry` 补工作区分组，订阅 `session/event` 做增量更新。
  - 做完你能看到什么：助理能拿到覆盖全部工作区、含未分组会话的完整清单。
  - 先依赖什么：2.1。
  - 开始前先看：`design.md` §3.1–§3.3；`requirements.md` 需求 1、2；`docs/20261004-会话汇聚与语音能力调查.md` §2、§3。
  - 主要改哪里：新增 `src/host/features/assistant-session-index.ts`；复用 `src/host/modules/peer-host/dsh-native-summary-source.ts` 已有结构。
  - 这一步先不做什么：不重复实现 PeerHost 通道；不自行读取会话存储文件；不遍历原始事件日志。
  - 怎么算完成：能处理 `listSessions()` 的 `{header,live,persisted}` 包装；标题取最后一条 `session/title`；59 个游离会话归入「未分组」而非丢弃；无标题会话为 `null`；读取不激活冷会话。
  - 怎么验证：集成测试 + 与本机实际会话对照（应得到 542 个唯一会话，其中 483 个有工作区分组、59 个未分组）。

- [ ] 3.2 等待处理状态接入
  - 状态：TODO
  - 这一步到底做什么：从 `approval/request`、`user-questions/request`（Host）与 `ctx.uiSession.pendingInteractions`（Client）获取等待状态，写入索引。
  - 做完你能看到什么：摘要能优先报出「有东西在等你处理」。
  - 先依赖什么：3.1。
  - 开始前先看：`design.md` §3.4；`requirements.md` 需求 7；调查文档 §5.2、§8。
  - 主要改哪里：索引模块的 waiting 字段来源与测试。
  - 这一步先不做什么：不用 `running` 推断等待状态；不靠扫描历史日志推断等待（本机 `approval/asked` 仅 2 条，样本不足以代表当前状态）。
  - 怎么算完成：运行中但未等待的会话不被报成待处理；等待项在摘要中优先出现；等待状态来自运行时事件而非历史扫描。
  - 怎么验证：构造审批/提问事件，检查摘要顺序。

- [ ] 3.3 派发器
  - 状态：TODO
  - 这一步到底做什么：实现目标解析后的投递，调用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content })`，处理错误与幂等。
  - 做完你能看到什么：一句「让 X 去做 Y」能把任务投到目标会话并回报结果。
  - 先依赖什么：2.2、3.1。
  - 开始前先看：`design.md` §5.3；`requirements.md` 需求 6。
  - 主要改哪里：新增 `src/host/features/assistant-dispatch.ts` 与测试。
  - 这一步先不做什么：不绕过 DSH 权限与审批边界；不新建跨 Host 派发通道。
  - 怎么算完成：`queue`/`steer` 选择正确；目标不存在时结构化错误；空任务被拒；重复 `requestId` 不重复插入。
  - 怎么验证：集成测试 + 在本机真实会话上手工派发一次。

## 阶段 4：语音接入

- [ ] 4.1 语音输入接入
  - 状态：TODO
  - 这一步到底做什么：先确认 `@deepseek-ai/dsh-experimental-voice-input-bundle` 是否已启用（`speechToText` 服务是否挂载）；再实现 Client 侧按住说话采集音频，Host 侧经 `ctx.speechToText` 转写，复用已下载的本地 SenseVoice 模型。
  - 做完你能看到什么：按住按钮说话，松开后文字出现在输入框。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §2.1、§7；`requirements.md` 需求 4；调查文档 §7。
  - 主要改哪里：Client 侧新增语音输入控件；Host 侧新增转写 RPC。
  - 这一步先不做什么：不做 barge-in，不做唤醒词，不接云端识别。
  - 怎么算完成：`speechToText` 服务可用（必要时在 GUI 插件页启用 bundle）；转写为空不提交；麦克风被拒有明确错误且键盘路径不受影响；松开立即停止采集。
  - 怎么验证：本机手工验证 + 错误路径测试。注意实测该 bundle 已在 profile 的 bundles 列表中，但 `cordis.patch.yml` 无对应条目，**服务可能尚未挂载**，需先确认。

- [ ] 4.2 语音播报接入
  - 状态：TODO
  - 这一步到底做什么：把摘要文本交给 TTS 播报，第一版可用浏览器 `speechSynthesis` 兜底。
  - 做完你能看到什么：问进展后能听到摘要。
  - 先依赖什么：2.1、4.1。
  - 开始前先看：`design.md` §4.2、§10 开放问题 1。
  - 主要改哪里：Client 侧播报模块。
  - 这一步先不做什么：不下载本地 TTS 模型（作为后续增强）。
  - 怎么算完成：播报文本无 Markdown/URL；播报期间可停止；TTS 不可用时降级为文字。
  - 怎么验证：手工验证 + 文本净化单元测试。

- [ ] 4.3 动作注册与意图闭环
  - 状态：TODO
  - 这一步到底做什么：把汇总与派发注册为 `voiceAgent` 动作，串起「转写 → 意图 → 动作 → 播报」完整链路。
  - 做完你能看到什么：说「现在进展怎么样」听到摘要；说「让 X 去做 Y」完成派发并回报。
  - 先依赖什么：2.3、3.3、4.1、4.2。
  - 开始前先看：`design.md` §2.1、§6；`requirements.md` 需求 5、6。
  - 主要改哪里：`src/host/features/voice-agent-actions.ts`。
  - 这一步先不做什么：不把意图逻辑写进语音服务内部。
  - 怎么算完成：端到端两条主路径可用；目标不唯一时反问。
  - 怎么验证：本机端到端手工验证，记录实际对话。

## 阶段 5：验证与文档

- [ ] 5.1 契约对照检查
  - 状态：TODO
  - 这一步到底做什么：把复刻实现与 `docs/20261004-voiceAgent服务契约调查.md` 逐条对照。
  - 做完你能看到什么：确认契约面一致，或明确列出有意差异。
  - 先依赖什么：2.3。
  - 开始前先看：`design.md` §6.2、§6.3；`requirements.md` 需求 5 验收标准 9、10。
  - 主要改哪里：调查文档补充对照结论。
  - 这一步先不做什么：不为了「看起来一致」而模仿参考实现里我们不需要的部分。
  - 怎么算完成：方法名、事件名、owner 匹配、超时语义逐条有结论；差异有理由。
  - 怎么验证：对照表逐条勾选。

- [ ] 5.2 完整验证与实现记录
  - 状态：TODO
  - 这一步到底做什么：运行项目要求的检查并记录结果。
  - 做完你能看到什么：实现、测试、调查证据和任务状态相互对应。
  - 先依赖什么：3.1、3.2、3.3、4.3、5.1。
  - 开始前先看：`design.md` §8。
  - 主要改哪里：`docs/开发记录/` 新增实现记录；本文件回写证据。
  - 这一步先不做什么：不在测试未通过时把状态写成 DONE。
  - 怎么算完成：`pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 与完整 `pnpm test` 通过；新增测试全部通过。
  - 怎么验证：上述命令的实际输出，记录通过数量。

- [ ] 5.3 更新 Spec 索引
  - 状态：TODO
  - 这一步到底做什么：把 spec013 加进根目录 `AGENTS.md` 的 Spec 索引，并登记新增开发记录。
  - 做完你能看到什么：从 `AGENTS.md` 能直接跳到本 Spec 的四份文档。
  - 先依赖什么：5.2。
  - 开始前先看：`AGENTS.md` 的「Spec 索引」与「文档索引与新增文档规则」。
  - 主要改哪里：`AGENTS.md`。
  - 这一步先不做什么：不顺手改动其它 Spec 的索引条目。
  - 怎么算完成：README、requirements、design、tasks 四条链接可跳转；开发记录已登记。
  - 怎么验证：点击链接检查；`git diff` 确认只增不改无关行。

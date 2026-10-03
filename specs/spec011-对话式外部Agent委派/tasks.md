# 任务清单 - 对话式外部 Agent 委派（人话版）

状态：M1 已实现；M2 角色规划、候选目标和依赖执行闭环已实现，阶段 3 恢复检查与最终检查待复核

## 这份文档是干什么的

这份任务清单把“选择目标、提交对话、Host 改写、子会话生命周期和验证”拆开。每个任务都写清楚依赖、改动位置、边界和验证方式；进入 Spec 实施后，每完成一个任务必须立即回写状态。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清恢复条件
- `IN_REVIEW`：已有结果，等待复核
- `DONE`：已完成并回写验证证据
- `CANCELLED`：取消并记录原因

## 阶段 0：边界和契约

- [x] 0.1 建立 Spec、调查记录和追踪索引
  - 状态：DONE
  - 这一步到底做什么：记录当前立即派发逻辑、故障证据、参考项目流程和目标业务边界。
  - 做完你能看到什么：需求、设计、任务和参考调查可以互相追踪。
  - 先依赖什么：无。
  - 开始前先看：`AGENTS.md`、`specs/000-Spec规范/Codex-Spec规范文档.md`、本 Spec 调查文档。
  - 主要改哪里：本 Spec 五份文档、`AGENTS.md` 索引。
  - 这一步先不做什么：不修改委派源码，不启动开发服务器。
  - 怎么算完成：主文档齐全，需求使用 WHEN/THEN/SHALL，任务包含完整上下文包。
  - 怎么验证：文档走查、`git diff --check`、链接和编号检查。
  - 对应需求：全部需求的范围定义。
  - 对应设计：`design.md` §1、§2、§8。

## 阶段 1：carrier 与 Client 输入

- [x] 1.1 确定并实现稳定 carrier 编解码
  - 状态：DONE（M1）
  - 这一步到底做什么：在纯逻辑层定义带版本和 adapter ID 的 carrier，提供插入、解析、清理、重复目标和损坏输入处理。
  - 做完你能看到什么结果：给定草稿和 Agent 目录，可以稳定得到目标列表与干净任务文本。
  - 先依赖什么：0.1。
  - 开始前先看：`requirements.md` 需求 2；`design.md` §3.2、§3.3.2、§4.1、§6.2。
  - 主要改哪里：`src/client/delegate-plan.ts`、必要时新增 Host 共享 carrier 模块、对应纯逻辑测试。
  - 这一步先不做什么：不调用子会话，不改普通对话提交路由。
  - 怎么算完成：adapter ID 不依赖 label；非法、未安装、已停用和空任务都有稳定错误；carrier 可从模型可见文本中清理。
  - 怎么验证：carrier 单元测试、损坏输入测试、`pnpm run typecheck`。
  - 对应需求：`requirements.md` 需求 2 / 验收 2.1–2.4。
  - 对应设计：`design.md` §3.2.1、§3.3.2、§4.1、§6.2。

- [x] 1.2 让 `/委派` 选择动作只写入当前草稿
  - 状态：DONE（M1）
  - 这一步到底做什么：扩展 Client 输入最小契约，在 `onSelect()` 插入 carrier 并保留用户原文，删除直接 `cli/delegate` 调用。
  - 做完你能看到什么结果：选择 Command Code 后输入框出现目标 mention，用户可以继续输入任务，Host 没有创建子会话。
  - 先依赖什么：1.1。
  - 开始前先看：`requirements.md` 需求 1；`design.md` §2.2、§2.3.1、§3.3.1。
  - 主要改哪里：`src/client/delegate-command.ts`、Client 输入类型定义、`tests/subagent-delegate.spec.ts` 或对应 Client 测试。
  - 这一步先不做什么：不在 Client 侧读取最近历史消息，不增加新的 Host 派发入口。
  - 怎么算完成：`onSelect()` 只写草稿/提示；输入能力缺失时安全报错；已有任务文本不被覆盖。
  - 怎么验证：Client mock 测试、源码契约测试，确认没有选择即 `cli/delegate` 的调用链。
  - 对应需求：`requirements.md` 需求 1 / 验收 1.1–1.4。
  - 对应设计：`design.md` §2.2、§2.3.1、§3.3.1。

### 阶段检查 1.3

- [x] 1.3 carrier 与选择流程检查
  - 状态：DONE（M1）
  - 这一步到底做什么：只验证“选择目标 → 草稿出现 carrier → 没有子会话创建”这一段是否闭合。
  - 做完你能看到什么结果：可以进入 Host rewrite 开发，不需要再为 Client 选择动作补派发分支。
  - 先依赖什么：1.1、1.2。
  - 开始前先看：本 Spec `requirements.md` 需求 1、2；`design.md` §6.1、§6.2。
  - 主要改哪里：阶段 1 全部文件和测试。
  - 这一步先不做什么：不验证外部 CLI 的真实执行结果。
  - 怎么算完成：空草稿和带任务草稿都不会在选择动作创建 child session，carrier 解析结果稳定。
  - 怎么验证：定向测试、`git diff --check`、人工检查调用链。
  - 对应需求：需求 1、需求 2。
  - 对应设计：`design.md` §2.3.1、§6.1、§6.2。

## 阶段 2：Host 对话改写和当前 Agent 委派

- [x] 2.1 在普通提交链路接入 carrier 解析
  - 状态：DONE（M1）
  - 这一步到底做什么：在公共 Host 对话/`llm/stream` 边界解析提交消息，校验目标，去除内部 carrier，并拒绝空任务。
  - 做完你能看到什么结果：普通对话能得到结构化 `DelegationRequest`，空任务不会回退到历史消息。
  - 先依赖什么：1.3。
  - 开始前先看：`requirements.md` 需求 2、3；`design.md` §2.3.2、§3.3.2、§3.3.3、§5。
  - 主要改哪里：`src/host/cli-adapters/feature.ts`、新增或等价的 Host rewrite 模块、Host 集成测试。
  - 这一步先不做什么：不改变 `startContinuable` 的并发实现，不创建子会话。
  - 怎么算完成：DSH 和外部适配器都经过同一个解析边界；非法目标和空任务返回结构化错误。
  - 怎么验证：Host 路由测试、故障归档回放测试、`pnpm run typecheck`。
  - 对应需求：`requirements.md` 需求 2 / 验收 2.2–2.4；需求 3 / 验收 3.3。
  - 对应设计：`design.md` §2.3.2、§3.3.2、§5.1–§5.3。

- [x] 2.1a 生成 M1 委派约束指令并复用现有 `agent_subagent`
  - 状态：DONE（M1）
  - 这一步到底做什么：把任务、已校验目标及能力摘要改写成当前 Agent 可见指令，要求当前 Agent 调用既有 `agent_subagent`；不在 Host 代码中解析角色、候选或依赖关系。
  - 怎么算完成：DSH 和外部 Agent 走同一个 rewrite 边界，模型可见文本不包含内部 carrier，目标 ID 仍以稳定 adapterId 表达。
  - 怎么验证：rewrite 纯逻辑测试、`pnpm run typecheck`、定向 Host 流测试。
  - 对应需求：`requirements.md` 需求 3 / 验收 3.1–3.3。
  - 对应设计：`design.md` §2.3.2、§3.3.3。

- [x] 2.2 生成语义委派规划指令并复用现有工具
  - 状态：DONE（M2）
  - 这一步到底做什么：将允许使用的目标、catalog 能力和自然语言任务改写为当前 Agent 可以执行的规划指令，让它理解实现/测试/复核等角色、选择候选 Agent 并生成步骤依赖。
  - 做完你能看到什么结果：用户只提交一次对话，当前 Agent 能生成“Claude Code 实现 → Codex 测试 → Gemini/Cursor 复核”一类计划，并调用已有 `agent_subagent`/外部桥接能力。
  - 先依赖什么：2.1。
  - 开始前先看：`requirements.md` 需求 3、需求 8；`design.md` §2.3.2、§3.1、§3.2.3、§3.3.3、§6.1、§6.5。
  - 主要改哪里：Host rewrite 模块、委派规划提示/工具契约、`src/host/cli-adapters/subagent-tool.ts`、相关桥接和测试。
  - 这一步先不做什么：不让代码规则解析自然语言角色，不把子任务结果自动注入父会话，不复制每个 Agent 的派发代码。
  - 怎么算完成：指令包含任务、允许目标及能力摘要和规划约束；Host 拒绝不在允许范围内的 adapter ID；普通 DSH、Codex、Command Code 路径复用公共工具契约。
  - 怎么验证：rewrite 单元测试、规划提示契约测试、Host/工具集成测试、非法目标拒绝测试。
  - 对应需求：`requirements.md` 需求 3 / 验收 3.1、3.2、3.4–3.7；需求 8 / 验收 8.1–8.3；需求 7 / 验收 7.3。
  - 对应设计：`design.md` §2.3.2、§3.1、§3.2.3、§3.3.3、§6.1、§6.5。

- [x] 2.3 增加有依赖委派的等待和读取能力
  - 状态：DONE（M2）
  - 这一步到底做什么：让当前 Agent 能等待实现子任务完成、读取结果后再启动测试或复核，并把前置失败传给计划。
  - 做完你能看到什么结果：实现未完成时不会提前启动依赖它的测试；Gemini/Cursor 复核能读取前置结果。
  - 先依赖什么：2.2。
  - 开始前先看：`requirements.md` 需求 4、需求 8；`design.md` §2.3.3、§3.3.4、§3.3.5、§4.2、§6.6。
  - 主要改哪里：`src/host/cli-adapters/subagent-tool.ts`、`src/host/cli-adapters/native-subagent-dispatch.ts`、共享工具契约、等待/读取测试。
  - 这一步先不做什么：不新增自动结果汇总 UI，不让等待接口伪造完成状态。
  - 怎么算完成：支持按 child session 或步骤等待/读取；超时、失败和中断可被当前 Agent 感知；依赖循环被拒绝。
  - 怎么验证：顺序执行集成测试、等待超时测试、前置失败传播测试。
  - 对应需求：`requirements.md` 需求 4 / 验收 4.1–4.4；需求 8 / 验收 8.4、8.5。
  - 对应设计：`design.md` §3.3.5、§4.2、§6.6。

### 阶段检查 2.4

- [x] 2.4 对话式主链路检查
  - 状态：DONE（M2）
  - 这一步到底做什么：验证“选择 Agent → 输入任务 → 提交 → 当前 Agent 规划 → 按依赖调用工具”的完整主链路。
  - 做完你能看到什么结果：用户不需要再次打开委派弹层或依赖历史消息，真实任务能按计划进入正确的子会话。
  - 先依赖什么：2.1、2.2、2.3。
  - 开始前先看：本 Spec 全部需求、`design.md` §2.3、§3.2.3、§3.3.5、§6。
  - 主要改哪里：阶段 1、2 全部相关文件。
  - 这一步先不做什么：不增加 watch 面板或结果自动汇总。
  - 怎么算完成：空任务、单目标、多个目标、候选目标、依赖顺序、跨父会话读取和非法目标均有明确结果。
  - 怎么验证：`node --test tests/external-agent-pr.spec.ts tests/subagent-bridge.spec.ts tests/subagent-delegate.spec.ts tests/cli-adapters.spec.ts`（101/101 通过）；`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和 `git diff --check` 通过；人工走查请求链路完成。
  - 对应需求：需求 1、2、3、8。
  - 对应设计：`design.md` §2.3、§3.2.3、§3.3.5、§6.1、§6.2、§6.5、§6.6。

## 阶段 3：生命周期、错误和恢复

- [x] 3.1 拆分子会话生命周期状态和结构化错误（M1 基础）
  - 状态：DONE（M1 基础；M2 仍需扩展持久化观察）
  - 这一步到底做什么：把创建成功后的 `running`、首轮成功的 `completed`、执行异常的 `failed` 和取消的 `interrupted` 统一到工具结果，去掉“创建成功即完成”的歧义。
  - 做完你能看到什么结果：`ok: true && completed: false` 显示为运行中；真实 `turn/end` 错误和 child session ID 可追踪。
  - 先依赖什么：2.1、2.1a（M1 基础）；完整状态观察和持久化仍属于后续阶段。
  - 开始前先看：`requirements.md` 需求 4、6；`design.md` §3.2.5、§3.3.4、§4.2、§5、§6.3。
  - 主要改哪里：`src/host/cli-adapters/native-subagent-dispatch.ts`、`src/host/cli-adapters/subagent-tool.ts`、`src/host/cli-adapters/delegate-dispatch.ts`、共享契约和测试。
  - 这一步先不做什么：不改变 DSH 子会话底层存储，不自动向父会话写新用户消息。
  - 怎么算完成：状态流转有不变量；创建异常、执行异常、超时、中断各有错误码和真实详情；已有并发/去重限制仍有效。
  - 怎么验证：生命周期事件测试、错误透传测试、并发/去重回归测试。
  - 对应需求：`requirements.md` 需求 4 / 验收 4.1–4.4；需求 6 / 验收 6.2、6.3。
  - 对应设计：`design.md` §3.2.5、§3.3.4、§4.2、§5、§6.3。

- [ ] 3.2 保持父子会话恢复和刷新不重复
  - 状态：TODO
  - 这一步到底做什么：确认 child session 关联、侧栏打开和外部适配器恢复沿用现有能力，刷新不会再次派发。
  - 做完你能看到什么结果：用户能从侧栏进入独立子会话继续工作，父会话只保留追踪引用。
  - 先依赖什么：3.1。
  - 开始前先看：`requirements.md` 需求 5；`design.md` §2.3.3、§4.1、§6.4。
  - 主要改哪里：会话关联/恢复模块、`tests/subagent-delegate.spec.ts`、相关 session store 测试。
  - 这一步先不做什么：不设计结果自动汇总或 watch UI。
  - 怎么算完成：父子关联可查询，刷新/切换无重复创建，子会话可恢复。
  - 怎么验证：会话恢复集成测试、侧栏回放或现有 session store 测试。
  - 对应需求：`requirements.md` 需求 5 / 验收 5.1–5.4。
  - 对应设计：`design.md` §2.3.3、§4.1、§6.4。

### 阶段检查 3.3

- [ ] 3.3 生命周期和错误检查
  - 状态：TODO
  - 这一步到底做什么：只检查状态语义、错误追踪和恢复边界，不扩展产品范围。
  - 做完你能看到什么结果：任何失败都能回答“哪个目标、哪个父会话、哪个子会话、哪个阶段”。
  - 先依赖什么：3.1、3.2。
  - 开始前先看：`requirements.md` 需求 4、5、6；`design.md` §4、§5、§6。
  - 主要改哪里：阶段 3 全部文件和测试。
  - 这一步先不做什么：不新增自动结果注入。
  - 怎么算完成：所有状态终态、错误码和 child session 关联都有测试证据。
  - 怎么验证：错误/恢复定向测试和人工日志走查。
  - 对应需求：需求 4、5、6。
  - 对应设计：`design.md` §4.2、§5、§6.3、§6.4。

## 阶段 4：全量验证和归档

- [x] 4.1 更新旧语义测试和开发记录（M1）
  - 状态：DONE（M1）
  - 这一步到底做什么：将“选择即派发”和“空任务历史回退”的旧测试改为新契约，并记录实现决策、兼容边界和验证证据。
  - 做完你能看到什么结果：测试、Spec 和开发记录不再描述互相矛盾的委派语义。
  - 先依赖什么：3.3。
  - 开始前先看：`requirements.md` 全文、`design.md` §7、`AGENTS.md` 文档规则。
  - 主要改哪里：`tests/subagent-delegate.spec.ts`、相关 `tests/cli-adapters.spec.ts`、`docs/开发记录/20261002-对话式外部Agent委派实现记录.md`、`AGENTS.md` 索引。
  - 这一步先不做什么：不修改 dsh-web、Desktop 或外部 CLI。
  - 怎么算完成：旧测试全部映射到新需求；开发记录说明故障根因、关键决策和限制。
  - 怎么验证：定向测试、`git diff --check`、文档链接检查。
  - 对应需求：需求 6、需求 7。
  - 对应设计：`design.md` §7、§8。

- [ ] 4.2 最终检查点
  - 状态：IN_REVIEW
  - 这一步到底做什么：确认需求、设计、任务、测试和验证证据一一对应，准备进入实现评审。
  - 做完你能看到什么结果：新的 Codex 上下文可以按任务直接接手，不需要重新猜当前委派逻辑。
  - 先依赖什么：4.1。
  - 开始前先看：本 Spec 全部文件、`AGENTS.md`、项目验证命令。
  - 主要改哪里：本 Spec 全部文件和实现相关测试。
  - 这一步先不做什么：不追加新需求，不把 Spec 之外的 watch/汇总功能塞进来。
  - 怎么算完成：主流程、空任务、失败、并行、恢复和兼容检查均有证据；所有任务状态已回写。
  - 怎么验证：`pnpm run version:check`、`pnpm run capability:check`、委派定向测试和 `git diff --check` 已通过；`pnpm test` 当前被工作区既有的 stage0 启动器改动阻断（2 个 `bootstrap_args[@]` 测试失败），完整 `pnpm run typecheck` 同时受既有 CodeBuddy 改动的两个类型错误阻断，均不在本次委派变更范围内。
  - 对应需求：`requirements.md` 全部需求和非功能需求。
  - 对应设计：`design.md` 全文。

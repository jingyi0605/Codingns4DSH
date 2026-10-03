# 需求文档 - 对话式外部 Agent 委派

状态：M1 已实现；M2 角色规划、候选目标和依赖执行闭环已实现

## 简介

CodingNS 已经可以把外部 Agent CLI 接入 DSH 原生会话，也已有 `/委派` 菜单和 `agent_subagent` 桥接能力。当前入口把“选择目标”和“创建任务”绑在一起：弹层 `onSelect()` 立即调用 `cli/delegate`，因此用户还没有输入任务时就会创建子会话。发生异常时，父会话只收到“后台子代理失败”之类的通用通知，无法判断是目标选择、子会话创建还是外部 Agent 执行失败。

本需求参考 `BytePioneer-AI/codex-host` 在提交对话时使用 mention/carrier、由 Host 解析并改写模型指令的做法，保留 CodingNS 现有的 `/` 菜单交互。目标是让委派成为对话的一部分：选择目标不产生副作用，真实任务由用户提交，当前 Agent 决定并调用既有委派能力，子会话独立运行且生命周期可追踪。

## 术语表

- **System**：CodingNS for DeepSeek Harness 插件及其 DSH Host/Client 运行时。
- **委派目标**：用户在 `/` 菜单选择的外部 Agent 适配器，例如 `command-code`。
- **carrier**：写入当前草稿、用于稳定携带目标 Agent ID 的内部标记；提交前可显示为 Agent mention，提交后会被 Host 消费。
- **Host rewrite**：Host 在普通对话提交路径中解析 carrier、移除内部标记并追加明确委派指令的过程。
- **父会话**：用户当前输入任务的 DSH 会话。
- **子会话**：由当前 Agent 调用 `agent_subagent` 或外部桥接后创建的独立 DSH 可续会话。
- **创建完成**：Host 已拿到 child session ID；它不代表子任务已经执行完成。

## 范围说明

### In Scope

- `/委派` 目标选择只修改当前草稿，不直接派发。
- carrier 的稳定 adapter ID、插入、解析、去重和清理规则。
- 普通对话提交时的 Host 解析、任务改写和当前 Agent 委派调用约束。
- 子会话 `creating`、`running`、`completed`、`failed`、`interrupted` 状态及结构化错误。
- DSH 原生会话、Codex、Command Code 等外部适配器路径的兼容测试。

### Out of Scope

- 修改外部 Agent CLI 的协议或凭据管理。
- 复制 Codex Desktop 的私有 UI；入口仍然是 `/` 菜单中的“委派”。
- 本 Spec 新增子会话结果自动汇总、watch 面板或自动向父会话注入伪造用户输入。
- 删除现有独立子会话；子会话仍可在侧栏中打开并继续交互。

## 需求

### 需求 1：选择目标不立即创建子会话

**用户故事：** 作为用户，我希望在选择外部 Agent 后继续编辑任务，以便一次输入完整需求再提交。

#### 验收标准

1. WHEN 用户从 `/` 菜单选择“委派”并选择一个已启用的外部 Agent THEN System SHALL 只向当前草稿插入该目标的 carrier，并保持输入焦点可继续编辑。
2. WHEN 用户只选择 Agent 但没有提交任务 THEN System SHALL 不调用 `cli/delegate`、`startContinuable` 或 `agent_subagent`，也不创建子会话。
3. WHEN 用户已有草稿文本 THEN System SHALL 保留原文本，并将 carrier 插入到可被 Host 解析的位置。
4. WHEN 当前 DSH 不支持草稿写入能力 THEN System SHALL 不派发任务，并向当前会话显示可读错误。

### 需求 2：carrier 必须稳定携带目标

**用户故事：** 作为 Host，我希望从提交内容中准确得到 adapter ID，以便不依赖显示名称猜测目标 Agent。

#### 验收标准

1. WHEN carrier 被插入或序列化 THEN System SHALL 携带稳定的外部 Agent `adapterId`，显示名称只能作为展示字段。
2. WHEN 用户提交含一个或多个 carrier 的草稿 THEN System SHALL 解析出每个合法目标并去除内部 carrier 后再形成模型可见任务。
3. WHEN carrier 缺失、损坏、目标未安装或已停用 THEN System SHALL 拒绝该目标并返回结构化错误，不得回退到最近历史消息。
4. WHEN 用户复制、编辑或删除 mention 文本 THEN System SHALL 以 carrier 是否仍然存在为准；无法确认目标时不得猜测派发。

### 需求 3：提交对话后由当前 Agent 承担委派

**用户故事：** 作为用户，我希望用自然语言告诉当前 Agent 要做什么，以便由当前 Agent 按上下文决定如何委派。

#### 验收标准

1. WHEN 用户提交带有合法 carrier 和非空任务文本的普通对话 THEN System SHALL 在当前 Agent 的处理链路中生成明确的委派指令，包含目标 adapter ID、任务文本和调用约束。
2. WHEN 当前会话使用 DSH、Codex 或其他外部适配器 THEN System SHALL 复用已有 `agent_subagent`/外部桥接能力，而不是从 Client 重新直接创建子会话。
3. WHEN 任务文本为空或只包含 carrier THEN System SHALL 阻止委派并提示用户补充任务，且不得读取最近历史消息作为替代任务。
4. WHEN 草稿包含多个合法目标 THEN System SHALL 保留同一任务文本，并允许当前 Agent 对目标进行独立并行派发。
5. WHEN 用户在自然语言中指定“实现、测试、复核”等角色或阶段 THEN System SHALL 由当前 Agent 理解任务并生成角色分配和步骤依赖，Host 不得仅按显示名称猜测角色。
6. WHEN 用户提供多个候选 Agent（例如 Gemini 或 Cursor）用于同一角色 THEN System SHALL 将候选范围和真实能力信息交给当前 Agent，由当前 Agent 选择、并行比较或向用户询问；Host 只接受合法 `adapterId`。
7. WHEN 当前 Agent 生成多步骤委派计划 THEN System SHALL 在依赖步骤完成后再启动后续步骤，并保留每一步与 child session 的关联。

### 需求 4：创建、运行和结果状态必须分离

**用户故事：** 作为用户，我希望知道委派是刚创建、正在运行还是已经失败，以便不把“已创建”误认为“已完成”。

#### 验收标准

1. WHEN 子会话创建成功但尚未收到首轮结束事件 THEN System SHALL 标记目标为 `running`，并展示 child session ID 或可追踪引用。
2. WHEN 子会话收到成功的 `turn/end` THEN System SHALL 标记为 `completed`，并记录可读取的结果摘要或结果引用。
3. WHEN 子会话创建失败、外部 Agent 返回错误、超时或被中断 THEN System SHALL 标记为 `failed` 或 `interrupted`，并保留目标 adapter ID、child session ID（如已生成）和真实错误原因。
4. WHEN 只有创建结果返回 `ok: true`、`completed: false` THEN System SHALL 禁止显示“委派完成”。

### 需求 5：父子会话边界清晰且可恢复

**用户故事：** 作为用户，我希望子任务是独立会话，以便在侧栏中继续查看、恢复或单独处理。

#### 验收标准

1. WHEN 子会话创建成功 THEN System SHALL 保留父会话引用、目标 Agent 和 child session ID 的关联。
2. WHEN 父会话刷新、重新打开或切换到其他会话 THEN System SHALL 不重复创建已有子会话。
3. WHEN 用户打开子会话 THEN System SHALL 能继续使用该外部适配器的原生恢复能力。
4. WHEN 子会话结束 THEN System SHALL 不向父会话伪造新的用户输入；结果通过现有会话历史、状态通知或后续明确设计的观察接口读取。

### 需求 6：错误可诊断且不破坏既有入口

**用户故事：** 作为维护者，我希望错误能定位到具体阶段和目标，以便排查外部 Agent 失败，而不是只看到通用会话错误。

#### 验收标准

1. WHEN 目标解析失败 THEN System SHALL 返回包含错误码、目标标识和用户可读详情的结构化错误。
2. WHEN 创建阶段失败 THEN System SHALL 区分能力不可用、目标未安装/停用、父会话不存在和 DSH 原生桥接失败。
3. WHEN 执行阶段失败 THEN System SHALL 保留外部 Agent 的真实错误文本，并关联 child session ID。
4. WHEN 新委派链路不可用 THEN System SHALL 保留普通对话、外部 Agent 选择器和既有独立子会话能力。

### 需求 7：可验证、可维护和兼容

**用户故事：** 作为项目维护者，我希望委派逻辑有清晰的契约和自动化验证，以便后续扩展 Agent 时不重新引入空任务派发。

#### 验收标准

1. WHEN 修改 carrier、rewrite 或派发状态 THEN System SHALL 有对应的纯逻辑单元测试和 Host/Client 集成测试。
2. WHEN 运行项目标准验证命令 THEN System SHALL 通过 `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和 `pnpm test`，或在任务记录中明确已有基线失败。
3. WHEN 新增外部 Agent 适配器 THEN System SHALL 只依赖稳定 adapter ID 和公共派发契约，不复制一套目标识别逻辑。

### 需求 8：语义委派规划与候选目标

**用户故事：** 作为用户，我希望用自然语言安排不同 Agent 的角色和先后顺序，以便把实现、测试和复核交给最合适的外部 Agent。

#### 验收标准

1. WHEN 用户只提供任务和若干允许使用的 Agent THEN System SHALL 允许当前 Agent 根据任务语义拆分步骤、分配角色并生成委派计划。
2. WHEN 用户明确指定某个 Agent 承担某个角色 THEN System SHALL 将该角色约束传给当前 Agent，并在工具调用中使用对应稳定 `adapterId`。
3. WHEN 用户指定一个角色有多个候选 Agent THEN System SHALL 允许当前 Agent 根据 catalog 能力选择一个、同时调用多个候选，或在信息不足时向用户提问。
4. WHEN 委派计划包含依赖关系 THEN System SHALL 提供等待或读取前置 child session 结果的能力，避免测试或复核早于实现完成。
5. WHEN 当前 Agent 请求不在允许范围内的 Agent THEN System SHALL 在 Host 层拒绝该调用并返回可用目标，不得执行模型猜测出的未知目标。

## 非功能需求

### 非功能需求 1：可靠性

1. WHEN 用户重复提交同一目标和任务 THEN System SHALL 遵守现有父会话并发和去重限制，并返回明确状态。
2. WHEN Host 在创建后断线或进程重启 THEN System SHALL 依赖持久化的独立子会话恢复，而不是重新执行 Client 的选择动作。

### 非功能需求 2：可观测性

1. WHEN 委派经过解析、改写、创建和结束阶段 THEN System SHALL 能通过 debug 日志或结构化结果区分阶段、adapter ID、父会话和 child session ID。
2. WHEN 外部 Agent 返回未知错误结构 THEN System SHALL 保留原始可读文本，并使用稳定的兜底错误码。

### 非功能需求 3：性能

1. WHEN 用户选择 Agent THEN System SHALL 只更新草稿，不启动 CLI、网络请求或子会话创建流程。
2. WHEN 多个目标被当前 Agent 独立派发 THEN System SHALL 不因 Client 逐个回调而串行阻塞；创建并发仍遵守 Host 现有上限。

## 成功定义

- 仅选择 Agent 不再产生空子会话；复现故障归档中的“只有 `继续` 输入、没有 `assistant/message` 或 `turn/end`”场景时不会创建子会话。
- 用户可以通过“选择 Agent → 输入自然语言任务 → 提交”完成一次可追踪委派。
- 用户可以表达“Claude Code 实现、Codex 测试、Gemini 或 Cursor 复核”等角色分工，当前 Agent 能生成带依赖的委派计划。
- 创建成功、执行中、完成和失败在接口、通知和测试中语义一致。
- 现有外部 Agent 会话、普通对话和侧栏子会话恢复能力不回归。

## M2 强制范围

需求 8 及其角色分工、候选 Agent 选择、步骤依赖、等待和读取能力属于委派功能的必需闭环，不再作为可选增强。M2 必须满足“当前 Agent 先规划，再按依赖调用子 Agent；后置步骤只能在前置步骤可读取的终态后启动”的业务语义。

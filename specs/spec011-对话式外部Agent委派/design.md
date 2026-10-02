# 设计文档 - 对话式外部 Agent 委派

状态：In Review

## 1. 概述

### 1.1 目标

- 把“选择委派目标”和“提交任务”拆成两个明确阶段。
- 让目标以稳定 `adapterId` 在草稿和 Host 之间传递，避免依赖显示名称或历史消息回退。
- 在普通对话链路中由当前 Agent 理解角色、拆分步骤、选择候选 Agent 并发起已有子代理工具调用，保留独立可续子会话。
- 让多步骤委派计划显式表达依赖，支持等待和读取前置子会话结果。
- 将子会话创建结果与执行生命周期分离，真实透传失败原因。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 8，以及全部非功能需求。

### 1.3 技术约束

- Client：`src/client/delegate-command.ts`、`src/client/delegate-plan.ts` 和 DSH `conversation.input` 最小契约。
- Host：`src/host/cli-adapters/feature.ts`、`delegate-dispatch.ts`、`native-subagent-dispatch.ts`、`subagent-tool.ts`。
- 传输：沿用现有 `cli/*` RPC 与 `llm/stream` 对话路由，不新增第二套外部 Agent 注册表。
- 子会话：沿用 DSH `startContinuable`、`CodingNsNativeSessionBridge` 和 `agent_subagent`。
- 兼容：不把 DSH 版本判断散落到委派业务中；能力差异继续由已有 capability/route 边界处理。

## 2. 架构

### 2.1 系统结构

```text
用户输入 / → Client /委派 popupSelect
                    │ 只插入 carrier
                    ▼
              当前会话 draft
                    │ 提交普通对话
                    ▼
        Host 对话入口解析 carrier + rewrite
                    │ 目标 adapterId、任务文本
                    ▼
              当前 Agent / llm/stream
                    │ 语义规划、选择候选、调用工具
                    ▼
       agent_subagent / wait / read
                    │
                    ▼
      native-subagent-dispatch → startContinuable
                    │
                    ▼
          独立外部 Agent 子会话
```

Client 负责选择和编辑体验，Host 负责解析、校验、改写、工具边界和生命周期，当前 Agent 负责自然语言规划与角色分配，DSH 原生子会话负责执行和恢复。选择动作不能跨越 Host 派发边界。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `delegate-command.ts` | 注册 `/委派`、列出目标、把目标写入草稿 | Agent 目录、当前会话输入 | 草稿更新、能力提示 |
| `delegate-plan.ts` | 纯逻辑：目标选项、carrier 编码/解析、任务清理 | adapter descriptor、draft | `DelegateCarrier`、任务文本 |
| `delegation-mention-rewrite.ts`（新增或等价 Host 模块） | 在普通对话提交前消费 carrier，生成明确指令 | 用户消息、carrier | 模型可见任务、目标列表 |
| `feature.ts` 的对话路由 | 把 rewrite 后的内容送入当前 Agent 处理链路 | Host 会话上下文 | 普通模型流、工具调用 |
| `DelegationPlanner`（当前 Agent 的工具约束与提示契约） | 根据自然语言理解角色、候选目标和步骤依赖 | 任务、允许目标、catalog 能力 | 结构化委派计划、工具调用 |
| `subagent-tool.ts` | 向当前 Agent 暴露 `agent_subagent` | 目标、任务、父会话 | 结构化创建/运行结果 |
| `native-subagent-dispatch.ts` | 创建独立子会话、监听首轮事件、控制并发 | adapter ID、prompt、父 Agent | 生命周期状态和错误 |
| `delegate-dispatch.ts` | 保留能力诊断和兼容 RPC；拒绝成为 Client 直接派发入口 | RPC 请求、Host 能力 | 能力/兼容错误 |

### 2.3 关键流程

#### 2.3.1 选择目标并编辑任务

1. `/` 菜单打开 `/委派`，Client 读取已安装且启用的外部 Agent 目录。
2. 用户选择目标，例如 `command-code`。
3. Client 通过 `conversation.input.for(session).setDraft()` 或 `paste()` 更新草稿，写入可显示 mention 和稳定 adapter ID 的 carrier。
4. Client 不调用 `cli/delegate`，不调用 `startContinuable`，不启动外部 CLI。
5. 用户继续编辑自然语言任务；再次选择目标时追加第二个 carrier，并按 adapter ID 去重。

#### 2.3.2 提交对话并改写

1. DSH 提交普通用户消息，Host 在进入当前 Agent 的 `llm/stream` 前调用 carrier parser。
2. Parser 校验 carrier 签名/版本、adapter ID、目标安装状态，并提取去掉 carrier 后的任务文本。
3. 任务文本为空时直接返回 `DELEGATE_TASK_EMPTY`，不读取历史消息。
4. Rewrite 生成当前 Agent 可执行的明确指令，至少包含：真实任务文本、允许使用的 adapter ID 和 catalog 能力、要求使用 `agent_subagent`/已有外部桥接、保持子任务独立会话、不要把目标 ID 当作任务内容误解。
5. 当前 Agent 根据自然语言理解角色和阶段，生成包含 `dependsOn` 的委派计划；“实现、测试、复核”等语义由模型处理，不写死在 carrier parser 中。
6. 当前 Agent 对多个候选 Agent 进行选择、并行比较或提问；Host 只校验工具调用中的稳定 `adapterId` 是否属于允许范围。
7. 当前 Agent 按计划调用 `agent_subagent`，通过 `agent_subagent.wait/read` 或等价观察能力等待和读取前置结果，再启动依赖步骤。
8. Host 从当前模型可见文本中移除内部 carrier；用户侧历史保留可读 mention，避免暴露内部控制标记。

#### 2.3.3 子会话生命周期

1. `agent_subagent` 校验父会话、目标 adapter 和非空任务。
2. `native-subagent-dispatch` 创建 child session，成功拿到 ID 后进入 `running`。
3. 后台模式不等待首轮完成；监听 `assistant/message`、`tool/result` 和 `turn/end` 更新状态。
4. 成功 `turn/end` 进入 `completed`；异常 `turn/end`、创建异常、超时和取消分别进入 `failed` 或 `interrupted`。
5. 当前 Agent 可通过 `agent_subagent.wait/read` 或等价观察能力等待和读取前置步骤；等待结果不改变子会话真实状态。
6. 结果通过结构化工具结果、子会话历史和状态通知可追踪；不得向父会话注入伪造的 `user/message`。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7、8。

- `DelegateCarrierCodec`：编码、解析和清理内部 carrier。
- `DelegationMentionRewrite`：将目标和任务转换为当前 Agent 的委派指令。
- `DelegationPlanner`：约束当前 Agent 输出角色分工、候选选择和步骤依赖；不由规则代码猜测任务语义。
- `DelegateLifecycleStore`：按父会话、目标和 child session 记录生命周期。
- `NativeSubagentDispatch`：复用现有 `startContinuable` 和事件订阅。
- `SessionInputFace` 扩展：提供草稿写入的最小兼容能力，并在能力缺失时安全降级。

### 3.2 数据结构

#### 3.2.1 `DelegateCarrier`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `version` | `1` | 是 | carrier 格式版本 | 只接受已知版本 |
| `adapterId` | `string` | 是 | 稳定外部 Agent ID | 必须来自 Host catalog，禁止使用展示名称替代 |
| `label` | `string` | 否 | 当前 UI 展示名称 | 仅展示和兼容旧草稿，不参与目标选择 |
| `nonce` | `string` | 否 | 同一草稿内的插入实例标识 | 用于重复插入、删除和调试，不作为权限凭据 |

线格式应同时满足“用户能看到 `@Command Code`”和“Host 能无歧义取到 `command-code`”。实现可采用 DSH 结构化 mention；若只能传字符串，则使用可逆的私有 carrier 包裹可见 mention，提交时必须完整剥离。

#### 3.2.2 `DelegationRequest`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `parentSessionId` | `string` | 是 | 父会话 ID | 必须存在 |
| `targets` | `DelegateTarget[]` | 是 | 解析后的目标列表 | 至少一个 |
| `task` | `string` | 是 | 去 carrier 后的自然语言任务 | trim 后不能为空 |
| `sourceMessageId` | `string` | 否 | 触发提交的用户消息 | 用于追踪和去重 |
| `allowedTargets` | `AllowedTarget[]` | 是 | 本次对话允许使用的目标及能力摘要 | 只能来自 Host catalog |

`AllowedTarget` 至少包含 `adapterId`、展示名称和 Host 已探测的能力摘要。能力摘要只用于当前 Agent 做候选判断，不替代 Host 对 adapter ID 的最终校验。

#### 3.2.3 `DelegationPlan`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `steps` | `DelegationStep[]` | 是 | 当前 Agent 生成的执行步骤 | 至少一个 |
| `selectionReason` | `string` | 否 | 候选 Agent 选择理由 | 不作为权限依据 |

#### 3.2.4 `DelegationStep`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `id` | `string` | 是 | 步骤 ID | 计划内唯一 |
| `role` | `string` | 是 | 例如 implementation、test、review | 由当前 Agent 理解，不由 parser 枚举限制 |
| `adapterId` | `string` | 否 | 已选定的目标 | 必须属于 `allowedTargets` |
| `candidateAdapterIds` | `string[]` | 否 | 尚待选择的候选目标 | 每个 ID 都必须属于 `allowedTargets` |
| `prompt` | `string` | 是 | 发给子 Agent 的任务 | trim 后不能为空 |
| `dependsOn` | `string[]` | 是 | 前置步骤 ID | 不得形成循环依赖 |

#### 3.2.5 `DelegateLifecycle`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `parentSessionId` | `string` | 是 | 父会话 | 不可变 |
| `adapterId` | `string` | 是 | 目标 Agent | 不可变 |
| `childSessionId` | `string` | 否 | 子会话 ID | 创建成功后写入 |
| `status` | `'creating' \| 'running' \| 'completed' \| 'failed' \| 'interrupted'` | 是 | 当前阶段 | 只允许合法状态流转 |
| `errorCode` | `string` | 否 | 稳定错误码 | 失败时优先写入 |
| `error` | `string` | 否 | 可读真实错误 | 不得用固定“完成”覆盖 |
| `resultRef` | `string` | 否 | 结果或会话引用 | 完成或可读取时写入 |
| `createdAt` / `updatedAt` | `string` | 是 | ISO 时间 | 更新时间单调不倒退 |

### 3.3 接口契约

#### 3.3.1 `SessionInputFace.setDraft` / `paste`

- 类型：Client function。
- 输入：当前 session scope、要写入的 draft 或 carrier 文本。
- 输出：void 或 DSH 输入更新结果。
- 校验：保留用户原有文本；不覆盖正在编辑的任务；能力不存在时返回明确不可用结果。
- 错误：`DELEGATE_DRAFT_WRITE_UNAVAILABLE`。

#### 3.3.2 `parseDelegationDraft(draft, catalog)`

- 类型：纯函数。
- 输入：草稿字符串或结构化 mention、当前外部 Agent 目录。
- 输出：`{ task, targets, cleanedDraft }` 或结构化解析错误。
- 校验：carrier 版本、adapter ID、目标安装/启用状态；禁止历史消息回退。
- 错误：`DELEGATE_CARRIER_INVALID`、`DELEGATE_TARGET_UNAVAILABLE`、`DELEGATE_TASK_EMPTY`。

#### 3.3.3 `rewriteDelegationPrompt(request)`

- 类型：Host function，挂在普通对话提交/`llm/stream` 前。
- 输入：`DelegationRequest`、当前 Agent 能力和已有工具清单。
- 输出：模型可见的明确委派指令及内部追踪元数据。
- 校验：必须包含任务和稳定目标 ID；不得把 carrier 原文继续交给模型。
- 语义约束：必须把允许目标及其能力摘要交给当前 Agent，但不要求 Host 代码解析实现/测试/复核等自然语言角色。
- 错误：`DELEGATE_REWRITE_UNAVAILABLE`；错误时保留普通对话回退，但不静默派发。

#### 3.3.4 `agent_subagent` 生命周期结果

- 类型：现有工具/Host bridge 扩展。
- 输入：`parentSessionId`、`adapterId`、`prompt`、可选模型。
- 输出：`{ ok, adapterId, childSessionId?, status, completed, result?, error? }`。
- 校验：`prompt.trim()` 非空；adapter 已安装启用；父会话存在；遵守并发和去重限制。
- 错误：`DELEGATE_PARENT_NOT_FOUND`、`DELEGATE_ADAPTER_UNAVAILABLE`、`DELEGATE_CREATE_FAILED`、`DELEGATE_EXECUTION_FAILED`、`DELEGATE_INTERRUPTED`。

#### 3.3.5 `agent_subagent.wait` / `agent_subagent.read`

- 类型：Host tool function，供当前 Agent 编排有依赖的委派步骤。
- 输入：`childSessionId` 或步骤 ID，可选超时和读取范围。
- 输出：当前生命周期状态、错误、结果摘要或子会话历史引用。
- 校验：只能读取当前父会话创建或明确授权的 child session；等待超时不能伪造完成。
- 错误：`DELEGATE_CHILD_NOT_FOUND`、`DELEGATE_WAIT_TIMEOUT`、`DELEGATE_RESULT_UNAVAILABLE`。

## 4. 数据与状态模型

### 4.1 数据关系

一个父会话可以拥有多个委派生命周期；一个委派计划包含多个步骤，每个步骤最多对应一个 child session。carrier 只存在于待提交草稿/用户消息，不能作为长期任务状态。计划以 `parentSessionId + sourceMessageId` 建立追踪，步骤以 `stepId` 关联，child session ID 生成后成为恢复和错误关联的主引用。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `creating` | 已从当前 Agent 发起创建 | 工具调用被接受 | 拿到 child ID 或创建失败 |
| `running` | 子会话已创建，正在等待首轮或继续执行 | 有 child ID | `turn/end`、中断、超时或执行错误 |
| `completed` | 子会话首轮成功结束 | `turn/end` reason 为 completed/stop | 终态 |
| `failed` | 创建或执行失败 | 异常、错误 reason、超时 | 可通过子会话恢复/重试产生新生命周期 |
| `interrupted` | 被用户或 Host 主动取消 | abort/interrupt | 可重新提交产生新生命周期 |

不变量：`completed === true` 只能对应 `completed`；`ok === true && completed === false` 只能对应 `creating` 或 `running`，绝不能映射为“已完成”。

## 5. 错误处理

### 5.1 错误类型

- `DELEGATE_DRAFT_WRITE_UNAVAILABLE`：Client 无法写入当前草稿。
- `DELEGATE_CARRIER_INVALID`：carrier 格式、版本或 adapter ID 无法解析。
- `DELEGATE_TARGET_UNAVAILABLE`：目标不存在、未安装或已停用。
- `DELEGATE_TARGET_NOT_ALLOWED`：当前 Agent 请求的 adapter ID 不在本次对话允许范围内。
- `DELEGATE_TASK_EMPTY`：去除 carrier 后没有真实任务文本。
- `DELEGATE_PLAN_INVALID`：当前 Agent 生成的步骤缺少任务、目标或必要字段。
- `DELEGATE_DEPENDENCY_CYCLE`：委派计划的步骤依赖形成循环。
- `DELEGATE_PARENT_NOT_FOUND`：父会话不存在或未注册。
- `DELEGATE_CREATE_FAILED`：`startContinuable` 或桥接创建失败。
- `DELEGATE_EXECUTION_FAILED`：子会话执行结束并带错误原因。
- `DELEGATE_INTERRUPTED`：被取消或中断。
- `DELEGATE_TIMEOUT`：在现有等待预算内未收到 `turn/end`。
- `DELEGATE_WAIT_TIMEOUT`：等待前置步骤结果超时。
- `DELEGATE_RESULT_UNAVAILABLE`：子会话结果暂时不可读取。

### 5.2 错误响应格式

```json
{
  "ok": false,
  "error_code": "DELEGATE_EXECUTION_FAILED",
  "adapter_id": "command-code",
  "parent_session_id": "parent-1",
  "child_session_id": "child-1",
  "detail": "外部 Agent 返回的真实错误文本",
  "status": "failed",
  "timestamp": "2026-10-02T00:00:00Z"
}
```

### 5.3 处理策略

1. 输入验证错误：在提交前阻止派发，保留草稿并给出补充任务提示。
2. 业务规则错误：目标未安装、重复目标或并发超限时返回结构化错误，不回退历史消息。
3. 外部依赖错误：保留 child session ID（若已生成）和真实外部错误，状态进入 `failed`。
4. 重试与恢复：只允许用户通过子会话恢复或重新提交新任务；刷新页面不能重复执行原选择动作。
5. 兼容降级：如果 Host rewrite 能力缺失，普通对话继续工作；`/委派` 目标选择不得偷偷恢复为立即派发。

## 6. 正确性属性

### 6.1 属性 1：选择与派发解耦

*对于任何* 已启用的 adapter，执行 Client `onSelect()` 后，系统都不应创建 child session；只有提交含非空任务的普通对话并经过当前 Agent 工具调用后才允许创建。

**验证需求：** 需求 1、需求 3。

### 6.2 属性 2：目标不猜测

*对于任何* 提交草稿，Host 只能依据合法 carrier 中的 adapter ID 选择目标；carrier 缺失或无效时不得使用显示名称、最近历史消息或默认 Agent 猜测。

**验证需求：** 需求 2、需求 6。

### 6.3 属性 3：完成状态真实

*对于任何* 尚未收到成功 `turn/end` 的 child session，生命周期都不得进入 `completed`，并且任何面向用户的状态都不得写“委派完成”。

**验证需求：** 需求 4。

### 6.4 属性 4：子会话可恢复且不重复

*对于任何* 已有 child session ID 的生命周期，父会话刷新或重新打开不会再次创建同一委派；子会话 ID 仍可用于侧栏打开和外部适配器恢复。

**验证需求：** 需求 5、非功能需求 1。

### 6.5 属性 5：语义规划与目标边界分离

*对于任何* 用户任务，Host 代码只允许当前 Agent 使用 carrier/catalog 明确授权的 `adapterId`；角色理解、步骤拆分和候选选择由当前 Agent 完成，Host 不得根据 Agent 显示名称猜测任务角色。

**验证需求：** 需求 3、需求 8。

### 6.6 属性 6：依赖步骤不会提前执行

*对于任何* 含有 `dependsOn` 的委派计划，后置步骤只有在所有前置步骤进入可读取的终态后才能启动；等待超时或失败必须暴露给当前 Agent。

**验证需求：** 需求 4、需求 8。

## 7. 测试策略

### 7.1 单元测试

- carrier 编码、解析、清理、重复目标和损坏输入。
- 空任务拒绝，不读取历史用户消息。
- rewrite 指令包含稳定 adapter ID、允许目标能力、任务文本和工具约束。
- lifecycle 状态流转、错误码和 `completed` 不变量。
- 委派规划的角色分配、候选选择、依赖图和非法目标拒绝。

### 7.2 集成测试

- Client 选择 Agent 只调用草稿写入，不调用 `cli/delegate`。
- DSH、Codex、Command Code 路径从普通提交到 `agent_subagent` 的 Host 连接。
- 多目标并行派发遵守现有并发上限，同目标去重行为保持一致。
- `agent_subagent.wait/read` 能在实现完成后再启动测试和复核，并正确透传前置失败。
- `startContinuable` 创建失败、首轮 `turn/end` 错误、超时和中断的错误透传。

### 7.3 端到端测试

- 回放故障归档：只有 `继续` 或只有 mention 时不创建子会话，并显示 `DELEGATE_TASK_EMPTY`。
- 回放主流程：选择 Command Code → 输入任务 → 提交 → 创建独立 child session → 收到运行/完成状态。
- 回放语义规划：Claude Code 实现 → Codex 测试 → Gemini/Cursor 候选复核，并验证依赖顺序。
- 刷新父会话、切换侧栏并重新打开 child session，确认不重复派发。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1、2 | `design.md` §2.3.1、§3.2、§3.3.1、§6.1、§6.2 | Client/纯逻辑测试，源码契约检查 |
| `requirements.md` 需求 3、8 | `design.md` §2.3.2、§3.1、§3.2.3、§3.3.3、§6.5 | Host rewrite、规划提示契约和工具调用集成测试 |
| `requirements.md` 需求 4、5 | `design.md` §2.3.3、§3.2.5、§3.3.4、§3.3.5、§4.2、§6.3、§6.4、§6.6 | 生命周期事件、等待/读取和恢复回放 |
| `requirements.md` 需求 6、7 | `design.md` §5、§7 | 错误透传测试、完整项目验证命令 |

## 8. 风险与待确认项

### 8.1 风险

- DSH 当前公开输入契约可能只有 `draft` 读取能力，需通过能力探测扩展 `setDraft`/`paste`；若直接强转会在不同 DSH 版本上破坏输入框。
- 普通对话的 `llm/stream` 路由同时服务 DSH 和外部 CLI，rewrite 必须放在公共边界，不能为某个 Agent 复制一份派发逻辑。
- 结构化 mention 若无法跨 DSH 版本持久化，字符串 carrier 的清理和历史渲染需要额外兼容测试。
- 现有 `native-subagent-dispatch` 有并发、去重和首轮监听逻辑，重构时不能把这些限制退回到 Client。
- 当前 Agent 的语义规划依赖模型能力，不能用单元测试穷举所有角色表达；必须用工具边界、catalog 白名单和失败反馈限制其行为。

### 8.2 待确认项

- DSH 目标版本中 `conversation.input` 的 `setDraft` 与 `paste` 哪个是稳定公开接口；实现任务先以能力探测和最小适配层确认。
- carrier 的最终线格式选择结构化 mention 还是私有字符串包裹；必须在不暴露内部标记的前提下覆盖复制、编辑和恢复。
- 生命周期状态是否需要持久化到现有 session store，还是首期只依赖子会话历史和运行时通知；由实现阶段结合 DSH 可用存储决定。
- `agent_subagent.wait/read` 是新增工具动作，还是映射到已有 `team/wait`、子会话读取接口；实现阶段需选择一套稳定公共契约。

# 需求文档 - CodingNS Agent Team 与 DSH Agent Team 分层集成

状态：技术规划修订完成，待实施。

## 简介

插件外部 Agent 适配器已经能够执行一轮、恢复会话、处理权限和问题、中断以及释放资源，但这些能力没有统一的成员和 Team 编排语义。本 Spec 先建立插件自有 `CodingNSAgentTeam`，再通过 `DshCodingNsAgentTeamAdapter` 为 DSH Agent Team 提供公开边界适配。

DSH `0.2.0-rc.1` 是当前实现目标；`0.1.7-rc.2` 调查资料保留为历史证据，不作为当前实现 API 的假设。

## 术语表

- **CodingNSAgentTeam**：插件 Host-only 的外部 Agent 编排核心，拥有成员、运行、任务和事件状态。
- **逻辑外部成员**：由插件创建并管理的外部 CLI 会话，不等同于 DSH Agent。
- **Provider 原生 sub-agent**：某个外部 adapter 自己提供的子 Agent API；属于可选能力。
- **DshCodingNsAgentTeamAdapter**：把 DSH Team 的公开请求、生命周期和可选镜像转换为 `CodingNSAgentTeam` 调用的边界层。
- **Provider Session**：外部 adapter 的可恢复会话标识，不等同于 DSH Session。
- **外部事件**：插件统一的文本、思考、工具、权限、问题、usage、完成和错误事件。

## 范围说明

### In Scope

- 实现 `CodingNSAgentTeam` 的 Team、Member、Run、Task 和 Event Journal 抽象。
- 通过现有 CLI driver 创建逻辑外部成员并执行 Codex、Claude Code 等 adapter。
- 统一父子关系、消息投递、任务、状态迁移、中断、释放和失败隔离。
- 为 adapter 声明可选的 Provider 原生 sub-agent 能力。
- 实现 `DshCodingNsAgentTeamAdapter`，将 DSH 公开 Team 入口映射到插件核心。
- 支持 DSH 生命周期通知和可选的 Proxy/只读摘要镜像。
- 提供插件详情 RPC、事件 cursor、脱敏 DTO 和详情面板。
- 在 DSH Team 不可用或能力缺失时，保留插件自有 Team 和普通 CLI 会话的安全降级。

### Out of Scope

- 修改 DSH Host、TeamService 私有字段、Agent prototype 或 continuation manager。
- 把所有外部 CLI 伪装成 DSH Agent，或覆盖官方 Team 工具名称。
- 假设所有 adapter 都支持原生 sub-agent、跨进程 exactly-once、worktree 或文件锁。
- 把 `providerSessionId` 当作 `dshSessionId`、`memberSessionId` 或 DSH Agent 身份。
- 在 DSH `agentTeam` projection 与插件 Team store 中双写同一份任务权威状态。

## 需求 1：CodingNSAgentTeam 核心能力

**用户故事：** 作为插件用户，我希望外部 Agent 有统一的 Team 成员和运行模型，以便不同 CLI 的差异被限制在 adapter 边界内。

### 验收标准

1. WHEN 创建 Team THEN System SHALL 生成稳定的 `codingNsTeamId`，并建立成员、运行、任务和事件的 Host-only 状态空间。
2. WHEN 创建成员 THEN System SHALL 返回稳定的 `codingNsMemberId`，并记录 adapter、model、effort、父成员和状态。
3. WHEN 同一成员存在活动 `runId` THEN System SHALL 拒绝第二次执行，不启动第二个外部运行。
4. WHEN adapter 失败 THEN System SHALL 只将对应成员或运行标记为 `error`，不影响其他成员和普通 DSH 会话。

## 需求 2：外部 adapter 统一执行

**用户故事：** 作为 Team 编排器，我希望用统一接口调用 Codex、Claude Code 等外部 adapter。

### 验收标准

1. WHEN 执行逻辑外部成员 THEN System SHALL 通过现有 driver/registry 调用执行、恢复、权限、问题、中断和释放能力。
2. WHEN adapter 不支持某项能力 THEN System SHALL 返回结构化的不可用诊断，不静默伪造成功。
3. WHEN外部事件到达 THEN System SHALL 转换为统一 `CodingNsAgentTeamEvent`，并保留 adapter 扩展字段的脱敏结构。
4. WHEN Provider Session 可恢复 THEN System SHALL 允许显式恢复；恢复不得重复执行已确认的请求。

## 需求 3：消息、任务和成员生命周期

**用户故事：** 作为 Team 用户，我希望父成员可以向外部成员发送消息、分配任务和中断运行。

### 验收标准

1. WHEN 父成员向子成员发送消息 THEN System SHALL 按 `teamId + memberId` 校验作用域，并返回可追踪的 delivery receipt。
2. WHEN 创建或更新任务 THEN System SHALL 维护 Owner、依赖、write scope、revision 和状态；同一层只能有一个任务权威来源。
3. WHEN 中断成员 THEN System SHALL 先中断外部运行，再更新成员状态；重复中断必须幂等。
4. WHEN Team 关闭或成员归档 THEN System SHALL 释放外部进程、订阅、队列和临时资源。

## 需求 4：Provider 原生 sub-agent 能力

**用户故事：** 作为 adapter 开发者，我希望只有真正支持原生 sub-agent 的 Provider 才声明该能力。

### 验收标准

1. WHEN adapter 提供原生 sub-agent API THEN System SHALL 通过可选 driver 契约声明 `native-subagent` 能力。
2. WHEN adapter 未声明原生能力 THEN System SHALL 回退到逻辑外部成员，不把普通独立会话标成 Provider 原生子 Agent。
3. WHEN 原生 sub-agent 生命周期与插件 Team 生命周期不一致 THEN System SHALL 以插件 `runId` 和状态机为外层权威，并保留 Provider 诊断。

## 需求 5：DSH Agent Team 适配

**用户故事：** 作为 DSH 用户，我希望 DSH Agent Team 能通过稳定接口调用插件外部 Team，而不让插件核心依赖 DSH 私有类型。

### 验收标准

1. WHEN DSH 公开 Team 能力可用 THEN `DshCodingNsAgentTeamAdapter` SHALL 将 DSH 的成员、消息、任务、中断和生命周期请求转换为 `CodingNSAgentTeam` 调用。
2. WHEN DSH Team 能力不可用 THEN System SHALL 保留 `CodingNSAgentTeam` 和普通 CLI 功能，不注册依赖 DSH 的入口。
3. WHEN 使用 DSH Proxy/摘要镜像 THEN System SHALL 明确区分 `dshMemberSessionId` 与 `codingNsMemberId`，不得把 Proxy 当作插件核心成员身份。
4. WHEN DSH API 变化 THEN System SHALL 只修改 adapter 和 capability route，不修改 CodingNSAgentTeam 核心契约。

## 需求 6：事件、详情和用户操作

**用户故事：** 作为用户，我希望看到外部 Agent 的真实执行细节，并能处理权限、问题、中断和恢复。

### 验收标准

1. WHEN 外部 Agent 产生文本、思考、工具、权限、问题、usage、完成或错误事件 THEN System SHALL 按成员和 run 生成单调 `eventSeq`。
2. WHEN Client 请求详情 THEN System SHALL 返回 adapter、model、effort、状态、当前工具、权限/问题、usage、错误和事件 cursor 的脱敏 DTO。
3. WHEN 用户响应权限或问题 THEN System SHALL 调用绑定 adapter 的现有响应契约，不允许 Client 直接操纵外部进程。
4. WHEN 事件窗口超过上限 THEN System SHALL 采用有界背压并保留状态、错误、权限和问题等关键事件。

## 需求 7：恢复、安全和失败隔离

**用户故事：** 作为部署者，我希望外部 Agent 崩溃、会话失效或 Host 重启不会泄露凭据或拖垮其他成员。

### 验收标准

1. WHEN Host、adapter 或 Client 重连 THEN System SHALL 通过 `codingNsTeamId + codingNsMemberId + runId + eventSeq` 恢复可重放窗口。
2. WHEN Provider Session 丢失 THEN System SHALL 标记成员为 `error` 或 `archived`，保留脱敏诊断，不自动重放请求。
3. WHEN 写入 Host store 或日志 THEN System SHALL 不保存 token、环境变量、完整命令行、完整本地路径或原始敏感输入。
4. WHEN Client 操作不属于当前 Team 或成员 THEN System SHALL 拒绝请求且不泄露 Provider Session 信息。

## 需求 8：版本兼容和向后兼容

**用户故事：** 作为现有插件用户，我希望新增 Team 层不会破坏当前 CLI 会话。

### 验收标准

1. WHEN 未启用 DSH Team THEN System SHALL 保持现有 CLI adapter 的检测、执行、恢复、权限、提问、中断和释放行为。
2. WHEN DSH 版本低于当前支持范围或 capability fixture 不满足 THEN System SHALL 禁用 DSH 适配层，但保留 CodingNSAgentTeam 可用性（若其自身依赖满足）。
3. WHEN 外部 Team 功能发生异常 THEN System SHALL 只影响对应 Team/member/run，不改变默认 DSH `llm/stream` 和其他会话。
4. WHEN DSH API 变化 THEN System SHALL 通过 capability route 和 adapter fixture 诊断，不在业务模块散落版本判断。

## 非功能需求

### 性能

1. 每个成员事件队列必须有界，详情首屏只读取摘要和最近窗口。
2. 单个成员的高频工具输出不得阻塞 DSH Agent Loop 或其他成员。

### 可靠性

1. 所有状态迁移按成员和 run 串行化，旧 generation 事件必须丢弃。
2. 单个外部成员失败时，其他成员、任务历史和默认 DSH 会话继续可用。

### 可维护性

1. `CodingNSAgentTeam` 核心不得导入 DSH 版本专属类型。
2. 新增 adapter 只需实现现有 driver 和可选 sub-agent 能力，不修改 Team 核心。
3. 日志必须能按 `codingNsTeamId`、`codingNsMemberId`、`dshMemberSessionId`、`runId` 和 `eventSeq` 关联。

## 成功定义

- `CodingNSAgentTeam` 能独立创建至少两个不同 adapter 的逻辑外部成员，完成消息、任务、执行、事件、中断、恢复和归档。
- `DshCodingNsAgentTeamAdapter` 能在 DSH `0.2.0-rc.1` 能力可用时提供稳定入口；DSH 不可用时不影响插件核心。
- Provider 原生 sub-agent 只对明确声明能力的 adapter 启用，普通会话不会被误标记。
- 插件详情可以展示外部执行细节，所有 DTO 和日志都经过脱敏。
- `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和相关单元/集成测试通过；不修改 DSH Host 源码。

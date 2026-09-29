# spec007：CodingNS Agent Team 与 DSH Agent Team 分层集成

状态：技术规划修订完成，待实施。

## 这份 Spec 解决什么问题

插件已经有 Command Code、Claude Code、Kimi CLI、Gemini CLI、Pi Agent、Codex、OpenCode 和 Grok Build 等外部 Agent 适配器，但这些适配器只提供各自的会话、流、工具事件、权限和恢复能力，没有统一的 Team 编排层。

本 Spec 先实现插件自有的 `CodingNSAgentTeam`，再通过 `DshCodingNsAgentTeamAdapter` 接入 DSH Agent Team。依赖方向固定为：

```text
DSH Agent Team
        │
        ▼
DshCodingNsAgentTeamAdapter
        │
        ▼
CodingNSAgentTeam
        │
        ├── Codex Adapter
        ├── Claude Code Adapter
        ├── Gemini Adapter
        └── 其他外部 Agent Adapter
```

`CodingNSAgentTeam` 是外部 Agent 编排的权威层；DSH 只负责通过公开接口提供入口、生命周期通知或可选的只读镜像。不得让核心层依赖 DSH 私有 `Agent`、`Session`、`TeamService` 或 projection 类型。

## 核心判断

- 插件逻辑子 Agent：可行性约 `8/10`。一个成员对应一个外部 CLI 会话，由插件统一编排。
- Provider 原生 sub-agent：可行性约 `4/10`。只有声明了明确原生能力的 adapter 才能启用，不能假设所有 CLI 都支持。
- 外部 Agent 直接成为 DSH 原生 Agent：不作为核心路径。DSH `SubagentProvider` 的 continuable 扩展只提供创建 seed，不能接管外部执行器。

因此第一阶段交付的是“逻辑外部成员 + 统一 Team 编排”，不是伪造 DSH Agent。

## 阅读顺序

1. `requirements.md`：分层范围、用户故事和验收标准。
2. `design.md`：核心接口、数据模型、适配边界和状态机。
3. `docs/20260929-CodingNSAgentTeam分层集成规划.md`：本次修订的决策、阶段门禁和迁移路径。
4. `docs/20260928-DSH-0.1.7-RC2-AgentTeam与外部适配器调查.md`：历史调查证据；调查对象仍为 DSH `0.1.7-rc.2`。
5. `docs/20260928-外部Agent代理成员技术规划.md`：上一版 Proxy 主方案，已被 20260929 分层规划取代，仅保留为历史记录。
6. `tasks.md`：实施任务和每项任务的验证证据。

## 当前范围

本 Spec 覆盖：

- `CodingNSAgentTeam` Host-only 核心编排层。
- 外部逻辑成员、父子关系、消息、任务、状态、事件和失败隔离。
- 复用现有 CLI driver 的执行、恢复、权限、提问、中断和释放能力。
- `DshCodingNsAgentTeamAdapter` 与 DSH Agent Team 的公开边界集成。
- 可选的 DSH Proxy/只读摘要镜像；不把它作为核心状态来源。
- 可选的 Provider 原生 sub-agent 能力声明和适配。
- 插件详情 RPC、事件 cursor、脱敏 DTO 和外部 Agent 详情面板。
- DSH `0.2.0-rc.1` 的 capability route；旧版本继续安全降级。

明确不在本 Spec 内：

- 修改 DSH Host、TeamService 私有字段、Agent prototype 或 continuation manager。
- 让所有外部 CLI 伪装成 DSH Agent，或把 provider session 当作 DSH session。
- 覆盖官方 `spawn_teammate`、`send_message`、`team_task_*` 工具名称。
- 假设外部 CLI 都支持原生 sub-agent、跨进程 Team、worktree 隔离或文件锁。
- 在 DSH projection 和插件 store 中双写同一份 Team 任务权威状态。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制` 提供 capability route、fixture 和 Feature 门禁。
- 与 `spec006-PeerHost管理与多Host工作区会话聚合` 并列；不改变 PeerHost 的 HostScope 和代理边界。
- 复用 `CodingNsCliAdapterRegistry`、CLI driver、session store、消息 projector 和 native session bridge，但核心 Team 成员不直接复用 DSH session id。
- 不改变当前非 Team 模式下的外部 Agent 会话行为。

## 分层结论

```text
CodingNSAgentTeam（插件权威）
  ├── Team / Member / Run / Task / Event Journal
  ├── CodingNsCliAdapterRegistry
  └── 可选 Provider 原生 sub-agent 能力

DshCodingNsAgentTeamAdapter（边界层）
  ├── DSH 工具或 Host RPC 转换
  ├── DSH 生命周期通知转换
  └── 可选 Proxy roster 摘要镜像
```

官方 DSH Team 面板只能显示 DSH 自己拥有的成员和任务。外部 CLI 的完整工具、权限、问题、usage 和恢复详情必须由插件详情面板提供。

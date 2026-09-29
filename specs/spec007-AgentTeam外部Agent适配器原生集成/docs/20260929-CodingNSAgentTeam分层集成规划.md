# CodingNS Agent Team 分层集成规划

日期：2026-09-29

## 1. 结论先行

现行方案先实现插件自有 `CodingNSAgentTeam`，再通过 `DshCodingNsAgentTeamAdapter` 接入 DSH Agent Team。核心依赖方向如下：

```text
DSH Agent Team
      │
      ▼
DshCodingNsAgentTeamAdapter
      │
      ▼
CodingNSAgentTeam
      │
      └── CodingNsCliAdapterRegistry -> 外部 CLI
```

`CodingNSAgentTeam` 是外部 Agent 的唯一编排权威，DSH 适配器只是入口、生命周期通知和可选镜像。核心层不导入 DSH `Agent`、`Session`、TeamService 或 projection 类型。

## 2. 为什么改为分层方案

原 Proxy 主方案假设 DSH 原生 Team 可以直接承载外部 CLI。实际情况是：

1. DSH `SubagentProvider.prepareContinuable()` 只贡献 child session seed，不能接管外部 CLI 的每轮执行。
2. DSH `SpawnTeammateRequest` 没有 adapter、model、effort 和 provider session 字段。
3. 外部 CLI 没有统一的 DSH `send_message`、`team_task_*` 和 mailbox 执行上下文。
4. 当前 CLI driver 契约已经具备执行、恢复、权限、问题、中断和释放，但没有统一的 Team 成员抽象。

因此应先解决真实存在的问题：统一外部 Agent 编排。DSH 集成建立在这个稳定核心之上，而不是让 DSH 私有生命周期反向污染核心。

## 3. 三个交付级别

| 级别 | 能力 | 结论 |
| --- | --- | --- |
| L0 | `CodingNSAgentTeam` 管理逻辑外部成员 | 第一阶段必须实现 |
| L1 | DSH Lead 通过公开桥接接口调用 CodingNS | 第二阶段实现 |
| L2 | Provider 原生 sub-agent | 按 adapter 能力逐个实现 |
| L3 | DSH Proxy roster 镜像 | 公开 continuable Proxy 契约通过后再做 |

L0 的逻辑外部成员表示“一个插件成员对应一个外部 CLI 会话”，不宣称它是 Provider 内部原生 sub-agent，也不宣称它是 DSH Agent。

## 4. CodingNSAgentTeam 核心边界

核心负责：

- Team、Member、Run、Task、Event Journal；
- 父子关系和消息投递；
- adapter、model、effort 和 Provider session 绑定；
- 单活动 run、状态机、恢复、中断和释放；
- 外部事件序列、cursor、背压和脱敏；
- 逻辑成员与 Provider 原生 sub-agent 的能力区分。

核心不负责：

- DSH Agent 对象和 DSH Session projection；
- DSH 私有 mailbox 或 continuation manager；
- 官方 Team 工具注册和 DSH Web 私有组件；
- 所有外部 CLI 都具备的原生 sub-agent 假设。

## 5. DSH 适配器边界

`DshCodingNsAgentTeamAdapter` 是唯一依赖 DSH 类型的模块，负责：

- DSH 请求到 CodingNS DTO 的转换；
- CodingNS 成员摘要和错误到 DSH 可接受结果的转换；
- `agent/created`、`agent/status`、`agent/disposed` 等公开生命周期通知；
- 可选的 `dshMemberSessionId ↔ codingNsMemberId` 关联；
- capability 缺失时的 disabled/degraded 诊断。

适配器不得访问 TeamService 私有字段、修改 `agentTeam` projection、覆盖官方工具名称或把 DSH Agent 对象传入核心。

## 6. Provider 能力策略

现有 `CodingNsCliDriver` 继续承担普通执行路径。新增的 `native-subagent` 是可选 driver 扩展：

```text
driver 声明 native-subagent
  -> CodingNSAgentTeam 使用 Provider 原生子 Agent

driver 未声明
  -> CodingNSAgentTeam 创建独立逻辑外部成员
```

没有真实协议证据时，必须走逻辑成员路径。不能使用 provider 名称编码配置，也不能用独立外部会话冒充原生 sub-agent。

## 7. 状态和 ID 规则

以下身份必须始终分离：

```text
codingNsTeamId
codingNsMemberId
dshTeamId
dshMemberSessionId
providerSessionId
runId
eventSeq
```

插件只以 `codingNsTeamId + codingNsMemberId + runId` 管理外部运行。`providerSessionId` 只用于 adapter 恢复；`dshMemberSessionId` 只是可选集成关联。

## 8. 实施门禁

### 门禁 A：核心层

必须先证明 CodingNS 核心可以脱离 DSH 完成创建成员、消息、任务、执行、事件、中断、恢复和归档。

### 门禁 B：Provider 层

只有真实支持原生 sub-agent 的 adapter 才能进入原生路径。其他 adapter 继续使用逻辑成员，不阻塞 Team 核心。

### 门禁 C：DSH 适配层

必须验证 DSH `0.2.0-rc.1` 的公开 Team/Host/生命周期接口。没有公开 continuable Proxy 契约时，只交付 DSH 桥接模式，不实现 Proxy 镜像。

### 门禁 D：UI 层

核心状态机、作用域和事件 cursor 通过 Host 测试后，才实现详情 RPC 和 Client 面板。UI 不得掩盖生命周期错误。

## 9. 交付判定

只有满足以下条件，才能称为“CodingNS Agent Team 分层集成完成”：

1. `CodingNSAgentTeam` 可独立编排至少两个外部 adapter。
2. DSH 适配器可替换，核心不依赖 DSH 版本类型。
3. 逻辑成员和 Provider 原生 sub-agent 的能力边界清晰。
4. 外部事件、权限、问题、usage、恢复和中断均有 Host-only 状态与测试。
5. DSH 能力缺失时，插件核心和普通 CLI 会话继续可用。
6. 未通过公开 API 门禁的 Proxy 镜像不会被标记为 supported。

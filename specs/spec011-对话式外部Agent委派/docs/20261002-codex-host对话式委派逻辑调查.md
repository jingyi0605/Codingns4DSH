# Codex Host 对话式委派逻辑调查

调查日期：2026-10-02

## 1. 调查对象

- 参考仓库：<https://github.com/BytePioneer-AI/codex-host>
- 参考提交：`658ef5ad24119995462cf1f4723804b824e977d9`
- 关键文件：
  - `packages/renderer-extension/src/renderer-delegation-mention.ts`
  - `packages/shared-contracts/src/delegation-mention.ts`
  - `packages/host-runtime/src/delegation-mention-rewrite.ts`
  - `openspec/specs/cross-harness-delegation/spec.md`
- 本项目故障归档：`/Users/jackson/Downloads/dsh-session-64f4abf6-93d6-42c4-9406-d9df50a0f7b1.zip`
- 已解压分析文件：`/tmp/dsh-session-analysis/session.v4.jsonl`

## 2. 参考项目的业务逻辑

参考项目把委派拆成“表达目标”和“执行任务”两段：

1. 用户选择外部 Agent 时，渲染层只插入一个 mention/carrier；这个动作不创建外部会话。
2. 用户继续在对话框中输入自然语言任务并提交。
3. Host 从提交消息中解析目标，校验目标是否可用，并去掉内部 carrier。
4. Host 将目标和任务改写成当前模型可以执行的明确指令。
5. 当前 Agent 根据上下文调用委派工具，工具再创建外部 Agent 的独立会话。
6. 外部子会话的创建、执行、结果读取和 watch/等待是独立能力，不把创建 RPC 的返回值当成最终结果。

这套逻辑的关键不是复制其 UI，而是保持数据流边界：选择目标只产生数据，提交对话才产生业务动作。

## 3. 本项目当前逻辑

当前入口和职责如下：

- Client：`src/client/delegate-command.ts` 注册 `/委派`。popup `onSelect()` 读取草稿后直接调用 `cli/delegate`。
- 纯逻辑：`src/client/delegate-plan.ts` 的 `extractDelegateTask()` 只识别 `/委派` 文本，并允许目标名称作为前缀。
- Host：`src/host/cli-adapters/delegate-dispatch.ts` 校验目标、查找父 Agent、读取任务并调用 `dispatchNativeSubagent()`。
- 通用派发：`src/host/cli-adapters/native-subagent-dispatch.ts` 调用 `startContinuable()`，后台模式拿到 child ID 后立即返回，同时后台监听首轮 `turn/end`。
- 工具：`src/host/cli-adapters/subagent-tool.ts` 已注册 `agent_subagent`，可复用原生子会话和外部桥接。
- 路由：`src/host/cli-adapters/feature.ts` 提供 `delegate/capability` 和 `delegate` RPC。

当前数据流是：

```text
/委派 popupSelect
      │ onSelect
      ▼
cli/delegate RPC
      │
      ▼
startContinuable(background=true)
      │
      ├─ 立即返回 childSessionId、ok=true、completed=false
      └─ 后台等待 turn/end，失败时由 DSH 通知父会话
```

这里有两个业务语义冲突：

1. `onSelect()` 既表示“用户选了目标”，又表示“用户确认了任务”。
2. `ok: true` 表示子会话创建成功，但上层很容易把它显示成委派完成；真正的首轮结果稍后才会到达。

## 4. 故障归档证据

归档中的子会话 ID 为 `64f4abf6-93d6-42c4-9406-d9df50a0f7b1`，Provider 为 `codingns-external-command-code`，Label 为“继续”。事件只有一条 `继续` 输入，没有 `assistant/message`，也没有 `turn/end`。

父会话最终收到：

```text
Background subagent 64f4abf6-93d6-42c4-9406-d9df50a0f7b1 failed before it finished.
It left no closing message.
```

这说明用户只完成了目标选择或触发了空输入，系统却已经启动了子会话。子会话没有真实任务，因此既没有模型响应，也没有正常结束事件；父会话只能得到 DSH 的通用后台失败通知。

## 5. 差异和结论

| 维度 | 参考项目 | 本项目当前实现 | Spec 目标 |
| --- | --- | --- | --- |
| 选择 Agent | 写入 mention/carrier | 立即调用 `cli/delegate` | 只写入 carrier |
| 任务来源 | 用户随后提交的自然语言 | 草稿为空时回退最近用户消息 | 必须来自本次提交，空任务拒绝 |
| 目标识别 | 稳定 carrier/目标 ID | adapter ID + 显示名称前缀 | carrier 携带 adapter ID |
| 当前 Agent 角色 | 解析后调用委派工具 | Client/Host 直接创建子会话 | 当前 Agent 调用已有工具 |
| 创建与完成 | 独立观察 | `ok` 与后台失败通知容易混淆 | `creating/running/completed/failed/interrupted` 分离 |
| 子会话 | 独立可读、可等待 | 独立可续，但父侧通知语义粗 | 保留独立会话和 child ID 追踪 |
| 操作入口 | mention 交互 | `/` 菜单 | 仍保持 `/` 菜单选择 |

结论：本项目不需要再增加一个“选择后立即派发”的入口，而需要把现有 `/委派` 改成 carrier 生产器，并把目标解析放到普通对话提交的 Host 边界。现有 `agent_subagent`、`native-subagent-dispatch` 和 DSH 子会话能力应继续复用。

## 6. 语义规划补充结论

仅靠代码规则解析 carrier，只能回答“允许使用哪些 Agent”，不能回答“谁负责实现、谁负责测试、谁负责复核”。因此规划采用两层边界：

- Host 代码确定性解析 carrier、校验 `adapterId`、提供 catalog 能力摘要、限制可调用目标并维护生命周期。
- 当前 Agent 根据自然语言理解角色、拆分步骤、选择候选目标、生成 `dependsOn`，再调用 `agent_subagent`。

例如用户选择 Claude Code、Codex、Gemini 和 Cursor，并输入“Claude Code 实现、Codex 测试、Gemini 或 Cursor 复核”，Host 只把四个合法目标和能力摘要交给当前 Agent。当前 Agent 负责生成实现 → 测试 → 复核的计划；Host 通过 `agent_subagent.wait/read` 或等价观察能力保证依赖步骤不会提前启动。

如果当前 Agent 无法判断 Gemini 与 Cursor 的差异，应询问用户或同时运行候选复核，不能由 Host 根据显示名称硬编码选择。

## 7. 实施边界

首期只解决选择、提交、解析、派发和生命周期语义，不增加自动结果汇总。子任务完成后，用户仍可从侧栏打开独立子会话读取结果；后续若需要 watch 或父会话摘要，应另立需求和 Spec。

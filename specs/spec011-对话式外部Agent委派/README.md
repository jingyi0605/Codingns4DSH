# spec011：对话式外部 Agent 委派

状态：In Review

## 这份 Spec 解决什么问题

当前 `/委派` 的弹层选择会直接调用 Host 的 `cli/delegate`。用户只选择了 Command Code、还没有输入任务时，系统已经创建了外部子会话；空提示又可能回退到历史用户消息，最终产生没有首轮消息的失败子会话，并在父会话中显示含义不准确的失败通知。

本 Spec 把委派改成参考 `BytePioneer-AI/codex-host` 的对话式流程：选择 Agent 只把目标写进当前输入框，用户继续输入自然语言任务并提交；当前会话收到任务后解析允许使用的目标、改写为明确的模型指令，再由当前 Agent 理解角色、拆分步骤、选择候选 Agent 并调用现有的 `agent_subagent`/外部桥接能力。子会话的创建、运行、结束和失败分别记录，父会话不再把“创建成功”显示成“任务完成”。

## 阅读顺序

1. `docs/20261002-codex-host对话式委派逻辑调查.md`：参考项目、当前实现和故障证据。
2. `requirements.md`：用户可见行为和验收标准。
3. `design.md`：carrier、Host rewrite、状态模型和错误处理。
4. `tasks.md`：按阶段执行的任务和逐项验收方式。

## 范围

覆盖 `/委派` Client 命令、会话输入 carrier、Host 对话提交时的目标解析与改写、当前 Agent 的语义委派规划、候选 Agent 选择、子任务依赖和外部 Agent 子会话派发状态、错误追踪及对应测试。

不修改外部 Agent CLI 本身，不复制 Codex Desktop 私有 UI，不改变用户仍然通过 `/` 菜单选择“委派”和外部 Agent 的操作方式，也不在本 Spec 中设计自动把子任务结果注入父会话的 watch 产品能力。

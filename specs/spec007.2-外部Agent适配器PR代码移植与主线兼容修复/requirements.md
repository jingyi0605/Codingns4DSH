# 需求文档 - 外部 Agent 适配器 PR 代码移植与主线兼容修复

状态：已完成

## 需求 1：基于最新主线移植

系统 SHALL 以当前 `main` 为唯一基线，选择性移植 PR #6/#7 的实现，不保留旧 PR 的版本文件和提交历史。

验收标准：

1. `package.json`、`profile/package.json`、`version.json` 和共享版本契约保持当前 `0.2.0-beta.2 / DSH rc.2`。
2. 当前附件、权限、能力注册和 PeerHost 代码不被旧 PR 覆盖。
3. 不存在未解决冲突标记，`git diff --check` 通过。

## 需求 2：MiniMax Code 与 ZCode

系统 SHALL 通过现有 `CodingNsCliDriver` 与 `JsonRpcProcess` 边界接入 MiniMax Code 和 ZCode。

验收标准：

1. 能完成安装探测、模型目录、单轮文本流、会话绑定、续接、中断和释放。
2. ZCode 裸信封协议不携带错误的 `jsonrpc` 字段。
3. MiniMax ACP 与 `exec` 两条路径的错误和终态都能收敛为统一事件。
4. 外部进程异常退出时当前会话结束并可在下一轮重建，不得无限等待。

## 需求 3：权限和凭据边界

系统 SHALL 遵守 DSH 会话当前生效权限，不能因外部 Agent 路径而默认提升权限。

验收标准：

1. 不硬编码 `--permission full` 或等价的无限权限参数。
2. 未实现真实权限应答时不得声明 `permission`，并返回可解释诊断。
3. Host 不保存、复制或记录第三方 CLI 凭据。

## 需求 4：原生 Subagent 集成

系统 SHALL 选择性移植 PR #7 的 Provider 注册、原生子会话创建和 `agent_subagent` 工具，并兼容无 Subagent/Team 服务的 Host。

验收标准：

1. provider 注册、解除注册和适配器路由绑定具备明确生命周期。
2. 同步等待不会因订阅时序错过首轮 `turn/end`。
3. `run_in_background=true` 立即返回稳定的子会话标识。
4. 原生能力不可用时不注册不可用工具，并返回稳定诊断，不影响普通 DSH 会话。

## 需求 5：测试与回归

系统 SHALL 为新增驱动和 Subagent 路径提供可重复的 fake 协议测试，并验证现有功能不受影响。

验收标准：

1. 覆盖成功、取消、进程死亡、恢复、权限和后台路径。
2. 运行 `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和 `pnpm test`。
3. 测试失败时不得标记对应任务为 `DONE`。

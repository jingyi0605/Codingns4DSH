# spec007.2：外部 Agent 适配器 PR 代码移植与主线兼容修复

状态：已完成。

## 这份 Spec 解决什么问题

GitHub PR #6 和 PR #7 包含 MiniMax Code、ZCode 适配器以及 DSH 原生 Subagent 集成，但两个 PR 都基于旧版 `main`，与当前 `0.2.0-beta.2 / DSH 0.2.0-rc.2` 主线发生冲突。PR 中还带有过时版本文件、生成物、权限语义缺口和进程生命周期风险。

本 Spec 把 PR 内容拆成可审查的代码移植任务：保留有价值的驱动和 Provider 设计，重新适配当前主线契约，并补齐安全、恢复、测试和资源释放。

## 目标

- 在当前 `main` 基线上接入 MiniMax Code 与 ZCode 驱动。
- 保留当前 DSH rc.2 版本、能力矩阵、附件和权限契约。
- 选择性移植 Agent Subagent Provider 与 `agent_subagent` 工具。
- 清除 PR 生成物，不把旧版本元数据带回主线。
- 为进程退出、权限、原生子会话竞态和资源释放补充验证。

## 明确不做

- 不直接合并 PR #6 或 PR #7 的分支历史。
- 不回退当前插件版本或 DSH 兼容范围。
- 不提交 `.playwright-cli/`、`graphify-out/` 等生成物。
- 不把未经验证的权限、提问或后台能力写入能力声明。
- 不进行提交、推送、tag、Release 或 npm 发布。

## 关联资料

- [PR #6：外部 CLI 适配器](https://github.com/jingyi0605/Codingns4DSH/pull/6)
- [PR #7：原生 Subagent 集成](https://github.com/jingyi0605/Codingns4DSH/pull/7)
- `specs/spec007-AgentTeam外部Agent适配器原生集成/`
- `specs/spec007.1-外部Agent适配器扩展/`

## 交付顺序

先移植并稳定 PR #6 的两个驱动，再移植 PR #7 的原生 Subagent 路径；每个阶段完成后立即运行对应检查并回写 `tasks.md`。

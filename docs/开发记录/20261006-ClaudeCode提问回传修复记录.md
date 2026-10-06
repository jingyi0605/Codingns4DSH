# Claude Code 提问协议修复记录

## 现象与日志结论修正

用户提供的 `session-7714df74-e2ae-44d3-ab8f-f443ff28c15d` 会话中，模型反复用正文
询问“提问组件是什么”，没有发起结构化提问。`request/header` 和最终
`assistant/message.source` 标注 `deepseek-official/deepseek-flash`，但 seq 16 的
`request/context` 明确为 `claude-code/sonnet`。

此前仅根据外层消息的 source 判定“没有进入 Claude”不成立：当前 Registry 在接管外部
回合时追加 `request/context`，而 DSH 的外层请求头及消息 source 仍可能沿用原始模型
选择。会话导出也不是 Claude 原始线路日志，不能用缺少 `control_request` 记录来否定
外部协议执行。此次没有修改适配器路由。

## 两个参考项目的实际桥接

- 父仓库 `packages/session-sync-core/src/runtime/claude-runtime.ts` 注入
  `PreToolUse` 钩子，问题批准时保留原始输入并补充 `updatedInput.answers`；答案以原题
  文本为键。即使处于 `bypassPermissions`，也保留 `AskUserQuestion` 钩子。
- 参考项目 `codex-host/packages/adapters/claude-code/src/sdk-transport.ts` 使用
  Claude Agent SDK（代理软件开发工具包）的 `canUseTool` 回调；SDK 启动进程时添加
  `--permission-prompt-tool stdio`，通过标准输入输出上的双向控制消息处理提问。
- [Anthropic 官方用户输入文档](https://platform.claude.com/docs/en/agent-sdk/user-input)
  同样要求提供 `canUseTool` 回调，回答返回到 `updatedInput.answers`。

## 确认的根因

当前适配器只添加 `--permission-prompts host`。该参数决定提示由谁回答，却没有注册
标准输入输出上的权限处理器。`--permission-prompt-tool stdio` 才是 SDK 为
`canUseTool` 回调使用的协议入口。

直接使用本机 Claude Code 2.1.288，在相同的隔离配置中读取 `system/init.tools`：

| 启动参数 | 工具数 | 是否包含 AskUserQuestion |
| --- | --- | --- |
| `--permission-prompts host` | 20 | 否 |
| `--permission-prompt-tool stdio` | 23 | 是 |

探测使用临时 Claude 配置目录、禁止会话持久化、空设置来源和空 MCP 配置，并把 API
地址设为不可达的本机地址、API key 设为假值；收到初始化工具列表后立即结束 CLI。
没有请求真实模型，也没有操作 DSH 或 Desktop。

## 修复与数据流

适配器启动参数改为 `--permission-prompt-tool stdio`，使 CLI 向模型提供原生
`AskUserQuestion`。数据流保持为：

1. Claude 输出 `control_request`，其中 `subtype: can_use_tool`、
   `tool_name: AskUserQuestion`，并携带问题及 `tool_use_id`。
2. 驱动转换成公共 `question-request`，由消息投影器调用 DSH 原生 `askQuestions`。
3. 回答按 DSH 问题 ID 匹配，再用 Claude 原始问题文本作为答案键；多选用逗号连接，
   自定义回答去除首尾空白后回传。
4. 在同一进程回传 `control_response`，保留原始 `questions`，补充 `answers`、
   `toolUseID` 及 `decisionClassification: user_temporary`。
5. Claude 消费答案并继续当前回合。

此前补充的 `decisionClassification` 保留：批准为 `user_temporary`，拒绝为
`user_reject`，与参考项目的控制结果保持一致。单独补充回答字段无法让模型看到尚未
启用的提问工具，因此前一次修复不完整。

## 验证范围

- 本机 Claude CLI 原生初始化 A/B 探测，确认工具可见性差异。
- 直接从源码运行三个相关测试文件，共 23 个测试通过，未构建插件产物。
- `pnpm run typecheck` 和 `git diff --check` 均通过。
- 新增协议闭环回放覆盖完全权限模式、DSH 原生问题组件、多选、自定义答案、原题
  文本键及回答后继续输出；已有权限控制、工具参数分片和消息投影回归一起通过。
- 验证阶段未执行发布、提交、安装、启停或 Desktop 操作；保留其他正在进行的
  工作区改动。
- 真实模型选择及用户界面的实际点击仍需运行环境加载源码后验证；此次没有把源码
  修复描述为运行中插件已经更新。

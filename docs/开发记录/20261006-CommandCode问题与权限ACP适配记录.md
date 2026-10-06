# Command Code 问题与权限 ACP 适配记录

## 背景

Command Code 的 `-p --output-format json` 只适合单轮流式输出，不能让 DSH 原生问题组件等待用户回答。Command Code 文档同时提供了 `cmd acp` Agent Client Protocol（ACP）入口；其权限请求使用 `session/request_permission`，内置 `ask_user_question` 在 ACP 中复用同一个请求方法。

## 实现

- 正式 CLI Feature 以 `enableAcp: true` 注册 Command Code 驱动，启动 `cmd acp`，保留原有 `-p` 路径供历史兼容和直接测试使用。
- DSH 权限状态通过 ACP `session/set_mode` 映射：只读使用 `plan`，工作区可写且不询问使用 `auto-accept`，完全访问且不询问使用 `bypass`；未知或需要询问时使用 `default`。普通 CLI 的 `--plan`、`accept-edits` 和 `--yolo` 参数仅适用于旧的 `-p` 执行路径，不能替代 ACP 会话设置。
- ACP 的 `session/request_permission` 先检查 `toolCall.kind=other` 和 `toolCall.rawInput.question/options`。命中后转换为公共 `question-request`，固定选项按选项标签找到原始 `optionId`，再回传 `outcome.selected`。
- Command Code 1.74.3 的 ACP 服务原生只接受 `optionId`，会丢掉任意自由文本。适配器给自由文本回包使用保留的 `__codingns_custom__`，同时写入 `_meta["codingns/questionAnswer"]` 与 `answers` 扩展；启动子进程时通过 `command-code-acp-loader.js` 在内存中补齐 Command Code 的问题结果读取。loader 只匹配已验证的上游 bundle 代码，版本变化后不匹配则保持原实现，不修改 npm 安装目录或 Desktop 文件。
- 普通 ACP 权限请求继续使用通用权限解析器，保留 Provider 原始请求 ID 和 allow/reject 选项 ID，避免把普通工具审批误判成问题。
- 通用 ACP 驱动新增 Provider 自定义问题解析钩子，标准 `elicitation/create` 行为保持不变。
- 修复 ACP 版本探测把 Node shim 的非零退出误报为“未安装”：Desktop 进程直接执行 `command-code --version` 失败后，统一继续通过登录 Shell 解析绝对路径，并用登录 Shell 的 PATH 重试版本探测。该路径同样覆盖 Command Code 的 `cmd`、`cmdc` 和 `commandcode` 兼容入口。

## 会话包复核

用户提供的 `dsh-session-session-100e9b0c-f42b-4a0a-b825-8766c9f6ed99.zip` 只包含一份 `session.v4.jsonl`。其中 ACP 请求在启动前直接记录 `[command-code] Command Code 未安装` 和 `PROVIDER_ERROR`，没有版本输出、进程退出信息或 ACP 握手记录，确认故障点是本地命令探测而不是问题回传协议。

第二份 `dsh-session-session-3ff2a6c0-3975-4477-8922-6757acee18b5.zip` 同样只记录“未安装”。这两份导出都不足以直接证明探测失败的具体原因；第一轮只验证 PATH 回退，没有覆盖正式 Command Code ACP 所注入的 loader，结论不完整。

## 复报后定位与修复

- 真实 Command Code 1.74.3 在普通环境执行 `--version` 成功，注入旧 loader 后退出 1；对改写后的真实 bundle 做语法解析时得到 `SyntaxError: Unexpected reserved word`。
- 旧 loader 只替换 `function requestQuestion(e,t){`，却在真实代码的 `async function requestQuestion` 前插入辅助函数，使 `async` 错落到辅助函数，原问题函数中的 `await` 失去合法上下文。
- loader 改为匹配和替换完整的 `async function requestQuestion(e,t){`，保留原函数的异步语义；不满足已验证结构时保持上游源码不变。
- 通用 ACP 驱动增加 `sessionEnvironment`，Command Code 自由文本 loader 只随 ACP 会话进程加载，不再影响 `--version`、登录 Shell 或模型目录探测。现有 Cursor 的 `CI` 环境仍保持原有探测和运行行为。
- Command Code ACP 回归测试独立放在 `tests/cli-adapters-command-code-acp.spec.ts`，验证探测环境不注入 loader、会话环境仍注入 loader，以及实际导入和执行改写后的异步问题函数。

## 首轮验证（复报前）

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 新增测试覆盖 Command Code ACP 的启动参数、问题事件、问题回答和 DSH 权限映射。
- 新增测试覆盖自由文本扩展回包、loader 的内存改写和无关 ESM 模块保持不变。
- 新增 ACP shim 探测回归测试通过；在真实构建产物中模拟 Desktop 缺少 Node 的 PATH 时，成功解析并识别 Command Code 1.74.3。
- 完整 `npm test` 为 1442 个通过、3 个已有失败：Command Code Skill 测试的 macOS 临时目录 realpath（`/private/var` 与 `/var`）差异，以及两个无关的 OpenCode 事件断言；均与本次探测修复无关。

## 复报后验证

- 类型检查通过；本轮没有构建、启动 Stage0 或操作 Desktop。
- 直接内存加载当前源码执行 Command Code ACP 与 Cursor/Kiro 回归测试，9 个全部通过。
- 真实 Command Code 1.74.3 加载修正后的 loader 执行 `--version` 成功，输出 `1.74.3`。
- 在仓库内的隔离临时 HOME 中启动真实 `command-code acp`，仅发送 `initialize`，成功返回协议版本 1 和 Command Code 1.74.3；没有创建 Provider 会话或发送模型请求。
- 从真实上游 bundle 提取 `requestQuestion` 和 `askClient`，执行修正后的原始函数，自由文本（含多行、引号、反斜杠、中文与 emoji）、固定选项和取消均通过。

## 上游依据

- [Command Code Tools](https://commandcode.ai/docs/reference/tools)
- [Command Code ACP](https://commandcode.ai/docs/acp)
- [Command Code Permissions](https://commandcode.ai/docs/permissions)
- [ACP v2 Tool Calls：`session/request_permission` 回包](https://agentclientprotocol.com/protocol/v2/tool-calls)
- [ACP Elicitation：标准自由文本表单](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx)

## 套餐有余量但提示余额不足的复核

### 确认的事实

- 用户截图中 DSH 选择 `z-ai/glm-5.3-flash high`，终端使用 `deepseek-v4.1-flash max`。官方 Go 套餐文档同时包含这两个模型；ACP 文档明确说明其余额与套餐和终端共用。因此不能仅凭模型不同就断言套餐不支持，也不能把所有余额错误直接压掉。
- Command Code 1.74.3 的 `acp` 子命令 action 直接调用 `runAcp()`，不执行普通 CLI action 中的模型、权限和思考强度初始化。
- 在仓库内隔离 HOME、使用无效测试凭据和本地不可达 API 地址启动真实 CLI：传入 `--model z-ai/glm-5.3-flash --effort high --permission-mode accept-edits` 后，`session/new` 仍返回配置中的 DeepSeek 模型、`default` 权限和 `default` 思考强度。这确认了启动参数被忽略的适配缺陷。
- 当前截图未附对应的会话导出或原始 ACP 错误响应；两份早先导出只记录“未安装”。这些材料不足以证明本次余额错误的唯一原因。

### 本轮修复

- 通用 ACP 驱动新增可选 `configureSession` 钩子，在建立或恢复会话后、发送 `session/prompt` 前执行产品配置。未注册该钩子的适配器保持原有行为。
- Command Code 按顺序发送 `session/set_model`、`session/set_mode`、`session/set_config_option`，确保实际模型、权限和思考强度与 DSH 当前选择一致；任何设置失败都阻止继续对话，避免悄悄使用旧模型或旧权限。
- 订阅凭据读取改为与真实 CLI 相同：原生 `COMMAND_CODE_API_KEY` 环境变量优先于 `auth.json`。原先拼错的 `COMMANDCODE_API_KEY` 不再作为另一账户的订阅查询来源；即使没有 auth 文件，也支持原生环境变量认证。

### 本轮验证

- `npm run typecheck` 通过；Command Code ACP 与 Cursor/Kiro 源码回归测试 12 个、现有 Command Code 订阅测试 2 个全部通过。新增覆盖恢复后设置模型、六种权限输入，以及模型、权限和思考强度设置失败时不发送 prompt。
- 官方余额只读接口返回成功且月额度大于零。在仓库内隔离会话、复用现有 Command Code 账户，通过原生 ACP 设置 GLM 和 DeepSeek 后，两种模型都正常回复 `OK`。
- 使用修改后的真实源码适配器和子进程 loader，确认 GLM 模型、`high` 思考强度和 `auto-accept` 权限均生效。模型调用问题工具提问“7×8 等于多少？”，提供 `54`、`55` 选项；测试返回自由文本 `56`，模型回复“答案正确：56”。自由文本完整回传并进入后续模型上下文。
- 所有临时 HOME 和会话文件均在仓库 `data/` 内生成并清理；没有修改用户默认模型、账户文件、全局 CLI 安装或 Desktop。本轮没有构建、发布、启动或重启 Stage0。

补充依据：[Command Code Go 套餐](https://commandcode.ai/docs/plans/go)、[Command Code ACP 模型、权限及计费说明](https://commandcode.ai/docs/acp)。

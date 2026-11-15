# Antigravity Token 用量证据与夹具范围

核对日期：2026-11-15。基线：origin/main `267474c1`。

`antigravity-token-usage.json` 只保留真实记录中的 step 序号和 Token 数字，不含正文、工具参数或凭据。

## 本机只读核对

- DSH 会话 `session-e0577233-ce48-41b3-baa4-bc2ff8755385`：读取 `session.v4.jsonl.zstd` 的全部 667 条记录，确认三轮持久化用量与问题报告一致。该文件由多个 Zstandard frame 组成，不能只解压首个 frame。
- Antigravity 会话 `a78cea40-4ff6-48c6-a6e8-405531fe9098`：SQLite 通过 `mode=ro` 打开；按 `steps.idx` 排序，以 `step_type=14` 的用户输入划分三轮，分别有 29、13、14 条 `step_type=15` 的模型响应。
- 从 `steps.metadata` protobuf field 9 提取：2=input、3=output、5=cache read、9=thinking、10=text。56 条记录均满足 output=thinking+text；field 4 的缓存写入未出现，不能由此推断其他调用的缓存写入语义。
- 与同会话 `.system_generated/logs/transcript_full.jsonl` 的 56 条 `PLANNER_RESPONSE` 逐条核对 step 序号、input、output、cache read，全部相同。Transcript 模型为 `gemini-4-hydrogen-high`；56 条 `gen_metadata.data` 的 1.19 实际模型均为 `gemini-4-hydrogen`，1.21 展示名均为 `Gemini 4 Hydrogen (High)`。

| 用户回合 | 未缓存输入 | 输出（已含思考） | 其中思考 | 缓存读取 | input+output（等于 DSH 报告总量） | 最后调用 input+cache | 修正命中率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 115082 | 30452 | 15243 | 1616775 | 145534 | 92810 | 93.3550% |
| 2 | 40429 | 20036 | 10108 | 1365001 | 60465 | 119814 | 97.1234% |
| 3 | 38662 | 11415 | 3624 | 1788783 | 50077 | 139539 | 97.8844% |

缓存、输出的原生逐次合计与 DSH 三轮报告完全对应，原生输入合计等于各轮 DSH 总量减输出；旧适配器对非 Claude 模型再次从 input 中扣除 cache，随后公共投影使用归零的 `uncachedInputTokens`，因此持久化的输入为零。共享转换器及 DSH 投影无需修改。

## 协议依据与不确定性

[Antigravity 官方 headless 文档](https://antigravity.google/docs/cli/headless.md) 给出：

- `step_update.usage` 是 per-step 用量，`result.usage` 是整个会话的累计值。
- 两轮 stdin 示例的第二轮 input=278、output=4、cache=30214、total=282，累计 result 为 input=30662、output=8、cache=30214、total=30670。这与缓存独立分桶、total 不含缓存的口径一致。
- checkpoint 也可以携带用量，必须参与结算，但不能替代最后一次 agent_response 的输入规模。
- 参数/输入错误的 ERROR 信封可以携带全零 usage；不能把它当成既有会话被重置的证据。

[Magpie 的原生字段调查](https://github.com/yetone/magpie/issues/6720) 说明了上述 protobuf 字段布局，并明确 input 不含 cache read、output 含 reasoning；这是社区调查，非官方契约。本机 transcript 与数据库的一致性提供了独立交叉证据。此前 Claude 的非零缓存样本及 Gemini 零缓存样本保留回归。

没有找到本案例原始 stdout 的逐条 `step_update` 和最终 `result` 信封。夹具中的逐次 Token 数字真实，但测试根据公开协议重建事件，并按 input+output 构造 total、按逐次求和构造累计 result；它们不能作为原始信封或真实账单证据。官方文档也未完整定义所有自定义模型/中转服务的底层计费口径；后续真实 CLI 验证范围见下文 Stage0 实测。

## 修正后的映射与降级

- input 直接作为未缓存输入，cache read 保持独立桶；命中率为 cache/(input+cache) × 100%，不截断。
- output 不另加 thinking；保留上游显式 total（包括零或与桶和不同的值），仅缺省时沿用已知 CLI 的 input+output 口径，不把缓存强加进 total。
- 同一 step 序号以最新快照替换；整轮只结算一次，result 不重复叠加。最后一次 agent_response 的 input+cache 用作上下文输入占用，旧 step 通知和 checkpoint 不覆盖它；最后响应缺少 usage 时不沿用较早调用的占用。
- 完全缺少 step 明细时，使用已观察的会话累计差值。首次接入已恢复会话且没有基线，或任一累计桶回退时，省略无法确认的当轮 usage 并建立新基线；无法补回该轮的精确值。失败 ERROR 的空零信封不覆盖已有基线。
- 累计差值不能证明最后调用的上下文规模，只保留已知窗口容量，不用整轮合计伪造上下文分子。

## 实际验证

先加行为测试并确认失败，再修改实现。最终指定命令通过 43 项：

```powershell
node --import ./tests/register-source-loader.mjs --test tests/cli-adapters-antigravity.spec.ts tests/cli-adapters-antigravity-usage.spec.ts
pnpm run typecheck
pnpm run version:check
pnpm run capability:check
```

三个 pnpm 检查均通过；capability 检查提示现有 23 条失效路由，无新增或到期路由。

扩展源码回归运行过上述 Antigravity 两文件及 `dsh-message-projector`、`cli-adapters-claude-accounting`、`cli-adapters-claude-usage`、`cli-adapters-grok-usage`、`cli-adapters-kimi-gemini`、`cli-adapters-rpc`、`cli-adapters-stream`，共 174 项：165 通过、8 失败、1 跳过。随后补充最后响应缺少 usage 的上下文回归，包含在最终 43 项中。

8 个失败在未修改的主工作区 `main@267474c1` 重跑 `cli-adapters-rpc` 和 `cli-adapters-stream` 后全部复现：RPC 2 项涉及本机 Magpie 启动参数/MCP 事件预期，stream 6 项涉及 Claude 假进程缺少 `once` 或 stdio 权限参数预期。未改动这些文件；不能将此次扩展回归描述为全通过。跳过的是 Claude 的真实 DSH billing projection 测试，所需固定版本 `dsh-token-meter` 库不存在。

以上首次源码回归未构建、未启动真实 CLI/服务，也未修改用户运行环境或回写历史数据。DSH 投影断言通过代码回放验证；当时未验证运行中 Desktop、真实 CLI stdout 或供应商账单。

## 用户授权后的独立 Stage0 实测

2026-11-15 用户要求配置 Stage0 并提供直接打开的链接后，新建独立环境：

- 运行时复用本机 DSH `0.2.2-rc.1`；Home 为 `C:/Users/Administrator/.dsh-stage0-antigravity-token-accounting`，状态和启动器位于 `C:/Users/Administrator/.config/codingns4dsh/stage0-antigravity-token-accounting`。
- Profile `stage0` 的插件 junction 指向本修复 worktree。通过 `pnpm run dev:link stage0` 接入，`start.ps1` 调用仓库 `scripts/run-dsh-stage0.sh`，设置独立端口 `17906`、`TMPDIR` 和托管监听。
- Stage0 托管 Host/Client 首次编译成功，TypeScript 报告零错误。未运行 `pnpm build` 或 `pnpm test`。认证后首页 HTTP 200；`plugins/events` HTTP 200、类型为 `text/event-stream`，资源图包含源码插件。
- 真实 Antigravity `1.5.9` 的模型目录包含 `gemini-4-hydrogen`；会话设置保存回读成功。原生数据库三条 gen_metadata 均确认模型为 `gemini-4-hydrogen`，展示名为 `Gemini 4 Hydrogen (Low)`。

验收 DSH 会话为 `session-417366c7-e786-482a-b769-79f35f428ef4`，标题为“验收通过：Hydrogen Token 与非零缓存统计（三轮）”；三轮均绑定同一个原生会话 `fcecadec-edf4-45ec-b9de-711cc8e112c0`。测试只发送合成数据并要求简短回复，没有要求工具操作。

| 回合 | 未缓存输入 | 输出 | 缓存读取 | 保留总量 | 命中率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 13045 | 95 | 0 | 13140 | 0% |
| 2 | 3191 | 54 | 10991 | 3245 | 77.4996% |
| 3 | 2137 | 54 | 13141 | 2191 | 86.0126% |

已通过原生 RPC 回读、独立 Stage0 的持久化 Zstandard 日志、只读打开新生成的 Antigravity SQLite 三路核对：正式 assistant/message 恰好三份用量，逐轮输入/输出/缓存与原生记录相同，后续回合没有重复计入会话累计值。未缓存输入没有被缓存读取归零，命中率没有截断。

本机 `verification.json`、`native-comparison.json` 和 `environment-verification.json` 保存脱敏结果；`run.json` 保存本轮拥有的进程和配置路径。认证入口只放在本机启动日志和 `.url` 文件，不写入仓库。用户确认验收后，已关闭本次 Stage0 及其托管编译监听，核实 `17906` 无监听且本次进程全部退出；保留独立配置和验证记录。未操作 Desktop、原历史会话或其他已有服务；未进行浏览器点击验证，也未核实供应商账单或捕获本轮原始 stdout 信封。

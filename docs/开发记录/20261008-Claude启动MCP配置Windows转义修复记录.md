# Claude 启动 MCP 配置 Windows 转义修复记录

## 核心判断

问题真实存在，值得修复。当前源码中，会话启动和模型发现均把内联 MCP（模型上下文协议）JSON 传入 Windows `shell: true`。这条路径会把参数数组拼接为 shell 命令，JSON 双引号不再被作为数据可靠传递，与用户报错中的 `{mcpServers:{codingns:...}}` 一致。

本轮核实的是仓库源码和用户提供的错误特征，没有检查用户 Windows 机器的实际安装版本，也没有把用户此前的参数实验冒充为本轮实测。

## 关键洞察

- 数据结构：`claudeBridgeArgs()` 生成的 JSON 本身合法，损坏发生在参数传递边界。
- 复杂度：Claude 已支持配置文件，不需要为 JSON 再设计多层 cmd 转义。附加提示词同样可以使用文件形式。
- 风险点：npm 的 `claude.cmd` 仍需 cmd 执行，不能把所有入口机械改成 `shell: false`。
- 同类缺陷：模型发现不仅传递了内联空 MCP JSON，还传递 `--tools` 的空字符串参数；直接拼接会丢失空参数边界。

原实现的品味评分为「凑合」：注入层职责清晰，但启动层错误地把 Windows shell 当成参数数组透传通道，这是此次启动失败的直接缺陷。

## 修复方式

1. 增加 `src/host/cli-adapters/claude-process.ts`，统一 Claude 会话与模型发现的启动策略。
2. 原生 `.exe` / `.com` 和 POSIX 入口直接使用参数数组，关闭 shell 和原样参数模式。
3. Windows 包装器每次启动创建独立临时目录，把内联 MCP JSON 与附加提示词写入文件。参数分别使用 `--mcp-config <文件>` 和 `--append-system-prompt-file <文件>`。
4. 包装器沿用现有 `windowsShellInvocation()`，显式调用 cmd `/d /s /c` 并保留引号，处理命令路径、文件路径和空参数的边界。
5. 临时资源绑定进程生命周期；正常关闭、异步错误及同步启动异常均执行清理。取消、驱动释放与模型探测超时结束进程后走同一清理路径。清理遇到 Windows 文件占用会有限重试，不覆盖原始进程错误。
6. 调用方提供的现有 MCP 配置文件原样使用，不纳入临时资源清理。

通用流驱动仅增加可覆盖的启动方法，其他适配器仍使用原启动行为；Claude 注入层继续返回原始参数，不负责进程资源管理。

## 验证

- `pnpm run typecheck` 通过。
- 使用源码加载器运行 Claude 启动、模型、思考档位、工具流、通用流、迭代器生命周期和桥接测试：52 项通过，1 项 Windows 原生测试按平台跳过。
- 新回归覆盖配置与提示词逐字保真、空参数、并发隔离、启动同步异常、异步错误、正常关闭、会话中断、模型发现成功和超时、已有文件保护及原生程序直启。
- Windows 原生用例通过临时 `.cmd` 包装器和 Node 假 CLI 验证真实参数往返；已加入仓库，当前 macOS 环境未执行。仍需在 Windows 运行确认，不宣称完成了 Windows 真机回放。

回归命令：

```bash
node --import ./tests/register-source-loader.mjs --test tests/cli-adapters-claude-process.spec.ts tests/cli-adapters-claude-models.spec.ts tests/cli-adapters-claude-effort.spec.ts tests/cli-adapters-claude-tools.spec.ts tests/cli-adapters-stream.spec.ts tests/cli-adapters-iterator-lifecycle.spec.ts tests/subagent-bridge.spec.ts
```

本轮未构建、打包或发布，未操作 Desktop、dsh-web 或 Stage0 进程。工作区已有的豆包相关改动保持原样。

## 官方资料

- [Claude Code CLI 参数说明](https://code.claude.com/docs/en/cli-reference)：`--mcp-config` 支持 JSON 文件或字符串，`--append-system-prompt-file` 支持文件形式的追加提示词。
- [Node.js 子进程说明](https://nodejs.org/api/child_process.html)：Windows `.cmd` 需要命令解释器；`shell: true` 与参数数组组合已被弃用，shell 会解释参数中的元字符。

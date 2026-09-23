# Spec003：工作区启动、端口处理和服务代理

状态：Draft，范围已按真实需求收敛。

## 一句话说明

Spec003 只做三件事：读取 Workspace 级启动配置，按配置启动终端命令；检查配置中的端口并在用户确认后结束对应监听进程；把已经启动且确认过的进程服务接入插件自己的受控反向代理。

这不是通用的进程编排平台，不负责框架分析、自动改项目文件或管理多服务拓扑。

## 三项真实需求

1. **Workspace 配置和终端启动**
   - 每个 Workspace 使用一个受控配置文件，例如 `.codingns/debug.json`。
   - 配置记录启动名称、终端运行类型、相对启动目录、命令、参数、可选环境变量和端口。
   - Host 读取并校验配置，复用已有 `terminalProcess/*` 启动器创建 PTY 运行实例。
   - `terminal.id` 只用于打开或恢复 DSH 原生 Terminal；`instance.id` 才是运行、查询、恢复和停止的主键。

2. **端口检查和进程结束**
   - Host 按配置中的端口检查当前监听状态，并返回有限的进程信息供页面展示。
   - 用户明确确认后，Host 重新核验端口、PID 和进程启动身份，再结束对应监听进程。
   - Client 不提交 PID、绝对路径或任意端口目标；端口复用或身份变化时必须拒绝结束。

3. **指定服务的反向代理**
   - 对配置中启用代理的服务，Host 将已核验的本机监听服务绑定到插件自己的代理入口。
   - 代理目标只能来自 Host 根据 Workspace 配置和运行实例得到的回环地址与端口。
   - 插件内部实现受控 HTTP/SSE 转发、响应头过滤和重定向处理；WebSocket Upgrade 受 DSH 公开 Fetch 接口限制，当前明确返回不支持，不伪装成已实现。

## 已有前置能力

以下能力已经存在，不属于 Spec003 重复开发范围：

- `TerminalLaunchProfile`
- `TerminalProcessInstance`
- `TerminalProcessService`（兼容名称 `ProcessRuntimeService`）
- `terminalProcess/profile/list|create|delete`
- `terminalProcess/launch`
- `terminalProcess/runtime/list|get|stop`
- POSIX tmux/local-pty 和 Windows 独立 ConPTY broker
- 插件内部的受控 HTTP/SSE 反向代理

Spec003 不重新实现 tmux、local-pty 或 ConPTY；反向代理必须在插件内部实现，不调用 CodingNS 父仓库接口或私有源码。父仓库代码只能作为行为参考。

## 明确不做

- 非交互 `runtimeMode=process` 进程服务
- 框架分析、启动适配器、worktree 继承和多服务编排
- 端口租约、日志平台、AI 补丁和自动修复
- 自研 HTTP、SSE、WebSocket 代理引擎
- 修改 DSH 核心或覆盖默认 `connection`
- 把命令字符串写入已经存在的交互 Shell

## 文档入口

- [需求文档](requirements.md)
- [设计文档](design.md)
- [任务清单](tasks.md)
- [终端 PTY 启动器调用说明](docs/20260923-终端PTY启动器调用说明.md)
- [Spec003 继续开发提示词](docs/20260923-Spec003继续开发提示词.md)
- [父仓库移植范围与差异](docs/20260922-父仓库移植范围与差异.md)：仅作背景参考，未列入本 Spec 的能力不应继续移植

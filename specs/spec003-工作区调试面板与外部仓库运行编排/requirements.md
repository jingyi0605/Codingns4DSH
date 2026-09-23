# 需求文档：工作区启动、端口处理和服务代理

状态：Draft，范围已按三项真实需求收敛。

## 范围

本 Spec 的用户入口可以是 DSH 右侧栏页面，也可以先通过受控 RPC 验证；页面只是配置和操作入口，不增加第四类业务能力。所有涉及本机文件、终端、端口和进程的动作都由 Host 完成。

## 需求 1：读取 Workspace 配置并按配置启动终端命令

用户希望在 Workspace 中保存一次启动配置，之后用同一组参数启动项目，而不必把命令重新输入已有 Shell。

### 验收标准

1. WHEN Host 读取 Workspace THEN SHALL 只读取 Workspace 根目录内受控位置的配置文件，例如 `.codingns/debug.json`；不存在时返回空配置，不创建 Session 私有配置。
2. WHEN 配置文件存在 THEN SHALL 校验版本、配置项 ID、名称、相对工作目录、命令、参数、终端运行类型和端口格式；绝对路径和越出 Workspace 的 `..` 路径必须拒绝。
3. WHEN 用户启动配置项 THEN Host SHALL 使用已有 `terminalProcess/launch` 创建 PTY 运行实例，不把命令字符串写进已有交互 Shell。
4. WHEN PTY 启动成功 THEN SHALL 返回 `instance` 和 `terminal`；`terminal.id` 只用于打开或恢复 DSH 原生 Terminal，`instance.id` 才用于运行状态、恢复、查询和停止。
5. WHEN Session 切换、侧栏关闭、插件卸载或 generation 切换 THEN SHALL 只释放 attach/subscription，不得因此停止运行实例；只有用户明确停止时才结束终端进程。
6. WHEN 配置文件修改或删除 THEN SHALL 不静默改写已有运行实例；下一次启动读取新版本，旧实例仍按自己的 `instance.id` 管理。

## 需求 2：检查配置端口并结束对应监听进程

用户希望知道配置中的端口是否已监听，并在确认目标无误后结束占用该端口的进程。

### 验收标准

1. WHEN 用户请求检查端口 THEN Host SHALL 只检查当前 Workspace 配置中声明的端口，并返回监听状态、端口、有限的进程摘要和检查时间。
2. WHEN 端口未监听 THEN SHALL 返回明确的未监听状态，不创建虚假的运行实例或代理绑定。
3. WHEN 端口正在监听 THEN SHALL 允许用户查看目标摘要；Client 不得提交 PID、绝对路径或任意端口作为结束目标。
4. WHEN 用户确认结束监听进程 THEN Host SHALL 在执行前重新检查端口、PID、进程启动身份和保护进程名单；任一信息变化都必须拒绝执行并要求重新检查。
5. WHEN 目标确认无误 THEN Host SHALL 只结束该端口对应的受控进程或进程树并返回结果；不得因侧栏关闭、Session 切换、插件卸载或 generation 切换自动结束进程。
6. WHEN 端口被后来启动的其他进程复用 THEN 旧的 `instance.id`、检查结果和代理绑定不得用于结束或代理新进程。

## 需求 3：把指定进程服务接入插件反向代理

用户希望从 CodingNS 访问已经启动的本机开发服务，而不让浏览器直接连接 Host 或任意本机地址。

### 验收标准

1. WHEN 配置项启用代理且对应运行实例已由 Host 创建、端口已确认监听 THEN SHALL 创建绑定到该 Workspace、`instance.id` 和配置端口的代理目标。
2. WHEN 代理请求到达 THEN SHALL 由插件内部受控代理转发 HTTP 和 SSE 请求，并过滤 hop-by-hop headers；DSH 公开 Fetch 接口未提供 Upgrade 注册时，WebSocket 请求必须明确返回不支持。
3. WHEN Client 请求代理 THEN SHALL 只能引用 Host 返回的代理标识，不能提交任意 Host、URL、端口或本机路径。
4. WHEN 运行实例停止、端口检查身份变化或代理绑定失效 THEN SHALL 立即停用旧代理目标；旧地址不得转发到后来占用同一端口的进程。
5. WHEN 配置未启用代理、端口未监听或 Workspace/Session 校验失败 THEN SHALL 拒绝创建代理并返回可读错误。

## 共同安全边界

- Client 只发送 Workspace、Session、配置项和运行实例标识；Host 重新校验归属、路径和进程身份。
- 不向浏览器暴露 Host token、refresh token、秘密环境变量、任意绝对路径或未脱敏命令环境。
- 所有异步状态带 generation；旧 generation 的结果不得回写当前页面。
- 不修改 DSH 核心，不覆盖默认 `connection`，不让浏览器直连 CodingNS Host。

## 非目标

本 Spec 不验收：框架识别、非交互进程模式、多服务依赖、worktree 继承、端口租约、日志游标、AI 补丁、自动 HMR/callback 修复、容器调度以及 WebSocket Upgrade 扩展。

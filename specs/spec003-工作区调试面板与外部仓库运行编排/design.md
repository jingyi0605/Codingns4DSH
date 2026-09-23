# 设计文档：工作区启动、端口处理和服务代理

状态：Draft，按三项真实需求设计。

## 1. 设计原则

Spec003 的数据结构只有三层：Workspace 配置、终端运行实例、端口/代理观察结果。配置描述“以后怎么启动”，运行实例描述“这次实际启动了什么”，端口和代理描述“当前能否访问”。不建立独立的进程编排平台。

已有终端 PTY 启动器是前置服务。Spec003 只调用插件自己的终端服务；代理协议在本插件内部实现，父仓库只能作为行为参考，不能成为接口或运行时依赖。

## 2. 配置文件

默认文件位置为 Workspace 根目录下的 `.codingns/debug.json`。路径由 Host 根据权威 Workspace 根目录拼接，Client 只能提交 `workspaceId` 和配置项 ID。

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "frontend",
      "name": "前端开发",
      "cwdRelative": ".",
      "command": "pnpm",
      "args": ["dev"],
      "shell": { "profileId": "zsh" },
      "runtimeMode": "pty",
      "port": 5173,
      "proxy": { "enabled": true }
    }
  ]
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `version` | 当前为 `1`，未知版本拒绝读取 |
| `profiles[].id` | Workspace 内唯一、稳定字符串 |
| `name` | 展示名称 |
| `cwdRelative` | 相对 Workspace 根目录，禁止绝对路径和越界路径 |
| `command` | 要启动的可执行文件或命令名，不与参数拼成一条 Shell 字符串 |
| `args` | 参数数组，按原顺序传给已有终端启动器 |
| `shell` | 可选终端配置，沿用 `TerminalLaunchProfile` 的受控字段 |
| `runtimeMode` | 当前只允许 `pty`，复用已有 PTY 能力 |
| `port` | 可选的 1 到 65535 端口；只用于检查和代理绑定，不由 Client 任意覆盖 |
| `proxy.enabled` | 是否允许把该配置对应的已确认监听服务接入已有代理 |

环境变量只允许配置中明确列出的非秘密值。命中 `TOKEN`、`SECRET`、`PASSWORD`、`KEY` 等字段时不写入 Client 状态、日志或代理 URL。

## 3. 启动流程

```text
Client 选择 Workspace + profileId
  -> Host 校验 Session/Workspace 归属并读取 debug.json
  -> Host 校验 cwdRelative、command、args、shell 和 profile 版本
  -> 复用 terminalProcess/launch 创建 PTY ProcessInstance
  -> 返回 instance.id 与 terminal.id
  -> Client 用 terminal.id 打开/恢复原生 Terminal
  -> 后续状态、恢复、端口检查、停止全部使用 instance.id
```

`terminal.id` 是 attach 引用，不是运行数据主键。关闭 Terminal tab、切换 Session、插件卸载和 generation 切换只释放 attach/subscription。只有用户明确停止，Host 才调用已有终端服务结束实例。

Spec003 禁止将命令写入已有交互 Shell，也不重新实现 tmux、local-pty 或 ConPTY。

## 4. 端口检查和结束流程

```text
Client 请求检查 profileId 的 port
  -> Host 重新读取当前配置并校验 Workspace
  -> Host 查询该端口监听状态和有限进程摘要
  -> Client 展示未监听或监听信息
  -> 用户确认结束
  -> Host 重新查询端口、PID、启动身份和保护名单
  -> 身份一致才结束受控进程树，否则拒绝并要求重新检查
```

端口检查结果是短时观察结果，不是永久授权。端口不能单独证明进程归属；若进程身份发生变化，旧结果立即失效。Client 永远不提交 PID，Host 也不根据 Client 传入的任意端口执行结束。

平台差异封装在 Host 的端口观察器中。业务层只接收统一结果，不直接拼接 `lsof`、`ss`、PowerShell 或 `taskkill` 命令。

## 5. 插件内部反向代理

插件维护内存中的 `bindingId -> workspaceId/profileId/instanceId/port` 绑定，并通过 DSH 公开 Fetch 路由提供代理入口：

```text
workspaceId + profileId + instance.id
  -> Host 确认配置 port 正在监听
  -> 生成代理绑定/代理标识
  -> 插件校验运行实例和端口身份
  -> 插件转发到固定回环地址 `127.0.0.1:port`
```

代理目标必须由 Host 从当前配置和运行实例推导，只允许固定回环地址。插件过滤 hop-by-hop headers，保留 SSE 流式响应，并重写回环重定向的 `Location`。运行实例停止、端口身份变化或配置删除时，Host 立即撤销绑定。不能把代理目标保存成一个只含端口的全局记录，否则端口复用会把旧 URL 转给新进程。WebSocket Upgrade 当前不在已确认的 DSH Fetch 扩展点内，因此返回 501。

## 6. 最小 RPC

建议只增加以下接口：

```text
debug/config/get
debug/config/save
debug/profile/list
debug/profile/launch
debug/runtime/get
debug/runtime/list
debug/runtime/stop
debug/port/check
debug/port/terminate
debug/proxy/get
debug/proxy/enable
debug/proxy/disable
```

`debug/profile/launch` 内部调用已有 `terminalProcess/launch`；`debug/runtime/stop` 内部按 `instanceId` 调用已有终端服务。 `debug/port/terminate` 只接受 Host 生成的短时检查结果标识和用户确认意图，不接受 PID 或任意端口。

所有请求至少携带 `sessionId`、`workspaceId` 和当前 generation。Host 重新验证 Session 与 Workspace 关系，旧 generation 的响应不得更新新页面。

## 7. 右侧栏页面

页面注册为独立的 Client `debug` 功能模块，设置里的 `modules.debug` 控制启停。模块启用时注册右侧栏入口和 UI Slot，禁用时释放这些资源；Host 侧同名模块同步注销 Debug RPC handler 和代理路由，但不停止已有运行实例。页面提供“添加启动配置”表单，保存名称、命令、参数、相对目录、Shell、运行类型、端口和代理开关；提交整份配置给 Host，由 Host 校验并写入 `.codingns/debug.json`。已有配置页面提供启动/恢复/停止按钮、端口监听状态、确认结束按钮以及代理入口。无 Workspace 时显示空态，不创建额外配置。

页面不自行读取文件、不自行扫描端口、不保存 PID、不推导进程状态，也不复制 DSH 侧栏布局。

## 8. 错误和恢复

- 配置不存在：返回空配置，可由用户显式创建。
- 配置格式错误：返回字段和行列信息，不启动命令。
- Workspace 或 Session 不匹配：拒绝请求。
- PTY 启动失败：返回已有终端服务错误，不留下伪造运行实例。
- 端口身份变化：废弃旧检查结果和代理绑定，要求重新检查。
- Host 或插件重启：从已有终端服务按 `instance.id` 查询实例，不把 Terminal tab 是否存在当作运行状态。

## 9. 明确不实现的模块

不新增 `ProcessRuntimeService`、`FrameworkAnalysisService`、`LaunchPlanResolver`、`PortLeaseService`、`AiFallbackService` 或自研 `DebugReverseProxy`。若未来需要这些能力，必须另开 Spec 评审，不能从本 Spec 的三条需求中扩张。

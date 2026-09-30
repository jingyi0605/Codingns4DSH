# 设计文档 - 外部 Agent 适配器 PR 代码移植与主线兼容修复

状态：已完成

## 1. 设计原则

1. **数据结构先行**：DSH 会话只保存 `adapterId`、模型、思考档位和 Provider 会话标识；进程句柄、事件队列和凭据只存在 Host 内存。
2. **以当前契约为准**：驱动依赖 `CodingNsCliDriver`、`CodingNsCliTurnInput`、`CodingNsAgentEvent` 和现有注册表，不引入旧 PR 的版本判断。
3. **能力真实声明**：没有真实协议测试的能力不加入 `descriptor.capabilities`。
4. **失败隔离**：一个外部进程失败只能结束自己的会话，不能阻塞注册表、其他适配器或默认 DSH 会话。

## 2. 移植范围

### 2.1 从 PR #6 选择性移植

- `desktop-app-runtime.ts`：只保留可验证的桌面运行时发现逻辑。
- `mcode-catalog.ts`：复用模型与思考档位解析。
- `mcode-driver.ts`：复用 ACP/exec 事件映射，重新接入当前权限和附件输入。
- `zcode-driver.ts`：复用裸信封协议和会话事件映射。
- `json-rpc-process.ts`：只移植 `zcode` wire format，同时补进程退出通知和句柄失效。
- `feature.ts`、`model-catalog.ts`、Provider 图标：按当前主线手工合并。

### 2.2 从 PR #7 选择性移植

- `native-team-subagent.ts`：注册外部 Provider 并在 `prepareContinuable` 中绑定 Registry 会话。
- `subagent-tool.ts`：保留参数和同步/后台两种执行模式。
- `registry-holder.ts`、`native-subagent-holder.ts`：保存当前 Registry 和原生 Subagent 服务，停用时清空。
- `host/index.ts`：通过现有 Capability/Context 边界接入，并保存所有 disposer。

以下内容明确排除：旧版本元数据、`.playwright-cli/`、`graphify-out/`、旧客户端面板的过时注册逻辑。

## 3. 进程生命周期

`JsonRpcProcess` 必须提供以下状态语义：

```text
未启动 -> 运行中 -> 已退出
                  └-> 已释放
```

- stdout 结束或 `close/error` 事件发生时，标记进程不可复用。
- 拒绝所有 pending 请求，并通知当前回合事件队列结束。
- Driver 从 Registry 删除失效句柄；下一轮按会话和 cwd 创建新进程。
- `dispose()` 必须幂等，并清理定时器、监听器和子进程。

## 4. 权限映射

当前 Host 已在 `src/host/cli-adapters/feature.ts` 解析 `CodingNsCliPermissionState`。新驱动遵循：

- `workspace-write` 使用 Provider 的工作区写入模式。
- `read-only` 不得启动写入模式。
- `danger-full-access` 只有在 DSH 明确给出该状态时才能映射。
- Provider 不能自行把缺省权限解释成无限权限。
- 无法将 Provider 权限请求映射到 DSH 审批组件时，能力保持未声明并返回稳定错误。

## 5. 原生 Subagent 事件竞态

`startContinuable()` 返回后，子 Agent 可能已经开始甚至结束首轮。同步等待流程必须：

1. 先注册实时事件订阅，再读取子会话快照，避免读取与订阅之间丢事件。
2. 以事件序号或稳定事件内容去重，并只处理目标子会话。
3. 只在确认 `turn/end` 后返回；已结束的会话不得等待超时。

## 6. 能力和生命周期登记

- Capability 探测至少区分 `startContinuable/sendMessage` 与 `registerProvider`。
- Provider 注册返回的 disposer 必须挂到 Host Context 资源集合。
- 工具注册返回的 disposer 也必须在 Host 关闭或模块停用时执行。
- 无原生能力时不注册工具，普通 DSH 会话照常启动；当前主线没有旧版子代理面板回退，因此工具调用返回稳定的能力不可用错误。

## 7. 验证策略

### 单元测试

- JSON-RPC 裸信封、服务端请求应答、进程退出和取消。
- MiniMax ACP/exec 事件映射、模型目录、权限边界。
- ZCode 创建、发送、终态、失败详情和重建。
- Subagent 首轮快结束、后台启动、Provider 注册/解除注册。

### 集成回归

- 适配器注册表包含新适配器时，已有适配器目录和会话行为不变。
- 未安装新适配器不阻塞 Host 启动。
- 当前 rc.2 版本检查、能力退休检查和完整测试通过。

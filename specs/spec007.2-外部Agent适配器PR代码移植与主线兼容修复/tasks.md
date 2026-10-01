# 任务清单 - 外部 Agent 适配器 PR 代码移植与主线兼容修复

状态：实施中。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：外部条件阻塞，必须写明原因
- `DONE`：实现和验证证据已回写

只有有验证证据的任务才能标记为 `DONE`。

## 阶段 0：基线与范围

- [x] 0.1 审查 PR 与当前主线差异
  - 状态：DONE
  - 证据：PR #6/#7 基于 `fc9880d`，当前 `main` 为 `0f2a3e3`，GitHub 状态为 `CONFLICTING / DIRTY`；已完成补丁可应用性检查。

- [x] 0.2 建立隔离分支
  - 状态：DONE
  - 证据：当前分支为 `feat/port-external-agent-prs`，工作区初始干净。

- [x] 0.3 确定移植边界
  - 状态：DONE
  - 证据：确定先移植 #6 驱动，再移植 #7 Subagent；排除版本回退和生成物。

## 阶段 1：MiniMax Code 与 ZCode

- [x] 1.1 移植驱动和协议基础
  - 状态：DONE
  - 主要文件：`src/host/cli-adapters/mcode-driver.ts`、`mcode-catalog.ts`、`zcode-driver.ts`、`desktop-app-runtime.ts`、`json-rpc-process.ts`。
  - 验证：`pnpm run typecheck`；`tests/external-agent-pr.spec.ts` 的 ACP 和裸信封 fake 协议测试通过。

- [x] 1.2 接入当前注册表、模型目录和图标
  - 状态：DONE
  - 主要文件：`feature.ts`、`model-catalog.ts`、`provider-icons.ts`、`provider-icon-assets.ts`。
  - 约束：保留当前 Provider 色彩、版本和 UI 行为。
  - 验证：主线构建通过；未安装驱动返回空目录；模型目录和 Provider 图标已接线。

- [x] 1.3 修复权限和附件输入
  - 状态：DONE
  - 约束：使用当前 `CodingNsCliPermissionState`；禁止硬编码全权限；按驱动能力处理附件。
  - 验证：MiniMax ACP 附件块 fake 测试通过；未实现权限应答的路径不声明 `permission` 能力且保留保守拒绝。

- [x] 1.4 修复进程退出和自动重建
  - 状态：DONE
  - 约束：退出时关闭事件队列、失效句柄、清理 pending 和监听器。
  - 验证：`JsonRpcProcess` 退出通知、pending 拒绝、取消和幂等释放通过现有 RPC 回归；新驱动 fake 测试通过。

- [x] 1.6 完善 ZCode 桌面运行时与真实模型能力
  - 状态：DONE
  - 主要文件：`src/host/cli-adapters/zcode-driver.ts`、`src/host/cli-adapters/desktop-app-runtime.ts`。
  - 能力：发现 macOS/Windows 桌面运行时；同步账号 Provider 快照；解析真实模型与思维强度；通过 `session/setModel` 切换；查询会话和应用级用量。
  - 验证：本机 `/Applications/ZCode.app` 实际发现成功，`session/create` 返回真实模型和 `low/high/max` 思维强度；`pnpm run typecheck` 与外部 Agent fake 协议测试通过。
- [x] 1.7 接入 ZCode 套餐余额与剩余额度
  - 主要文件：`src/host/cli-adapters/zcode-subscription.ts`、`provider-subscription.ts`、`subscription-slot.ts`。
  - 能力：解密本机 `zcodejwttoken`，携带 `X-Device-Mid` 请求 `billing/balance`，按活动套餐聚合多模型总量、已用量和剩余量，并复用现有 `providerBalance` UI。
  - 验证：`tests/zcode-subscription.spec.ts` 覆盖密文、请求头、活动套餐过滤、聚合和失败响应。

- [x] 1.8 修复 ZCode 账号 Provider 的真实请求认证
  - 主要文件：`src/host/cli-adapters/zcode-driver.ts`。
  - 根因：app-server 的模型请求会反向调用 `interaction/requestProviderRuntimeHeaders`；旧实现返回空对象，账号请求最终被折叠为 `PROVIDER_ERROR`。
  - 修复：Host 从 ZCode 共享凭据读取对应账号 API Key，仅通过本地 RPC 返回 `headersApplied/requestAuth`，并为余额不足错误提供可读提示。
  - 验证：区分 Start Plan 试用额度和 Coding Plan API 余额；本机 `/Applications/ZCode.app` 实际执行已使用 `account:bigmodel-start-plan` 成功返回模型文本，不再误报 `1113`。

- [x] 1.9 美化订阅用量显示
  - 主要文件：`src/client/subscription-slot.ts`。
  - 能力：Token 数量统一使用 `K/M/B` 紧凑格式，账期结束时间使用浏览器 `toLocaleString()` 按本地时区显示。
  - 验证：完整测试套件通过。

- [x] 1.10 修复 ZCode Protocol 正文事件订阅与转换
  - 主要文件：`src/host/cli-adapters/zcode-driver.ts`、`tests/external-agent-pr.spec.ts`。
  - 根因：未调用 `session/subscribe` 时 app-server 只推送状态和遥测通知；真实正文位于 `session/event.payload`。
  - 修复：订阅 `desktop-continuous` 事件流，转换 `text_delta`、`reasoning_delta` 和完成快照，并保留旧版通知兼容。
  - 验证：fake 协议测试通过；本机 Start Plan 实际对话返回 `测试成功`。

- [x] 1.11 修复普通套餐选择被 Start Plan 遮蔽并验证真实调用
  - 主要文件：`src/host/cli-adapters/zcode-driver.ts`、`tests/external-agent-pr.spec.ts`。
  - 根因：设置选择普通 Coding Plan 时，旧逻辑只要发现登录 JWT 就强制切换到 Start Plan，普通套餐模型目录和请求因此不可见。
  - 修复：按 Provider 套餐类型分别检查 Coding Plan API Key 与 Start Plan JWT；尊重设置中的显式选择，仅在选中套餐缺少凭据时回退试用套餐；个人和团队 Coding Plan 共用该规则。
  - 验证：本机模型目录返回 `account:bigmodel-individual-coding-plan` 的 `GLM-5.3`、`GLM-5.3-Flash` 与 `low/high/max`；真实普通套餐调用已到达上游并返回 `1113`（账号无可用资源包），确认不是误走试用接口；回归测试和全套检查通过。

- [x] 1.12 统一 ZCode 用量 Logo 并美化余额弹层
  - 主要文件：`src/client/subscription-slot.ts`、`src/client/locales/usage.ts`。
  - 修复：官方余额没有 Logo URL 时回退当前适配器注册的内置 Logo；余额按总量和模型显示进度条，周期结束显示本地化倒计时，移除重复的明细文字。
  - 验证：客户端主题回归测试覆盖 Logo 回退、进度条和倒计时；ZCode 用量读取与路由测试通过。

### 阶段检查 1

- [x] 1.5 外部驱动门禁
  - 状态：DONE
  - 通过标准：两个驱动可独立失败，现有适配器回归通过，版本元数据保持 rc.2。证据：`pnpm run version:check`、`pnpm test`。

## 阶段 2：原生 Subagent

- [x] 2.1 移植 Provider 注册与 Registry 绑定
  - 状态：DONE
  - 主要文件：`native-team-subagent.ts`、`registry-holder.ts`、`host/index.ts`。
  - 约束：保存 Provider disposer，能力缺失时清晰降级。

- [x] 2.2 移植 `agent_subagent` 工具
  - 状态：DONE
  - 主要文件：`subagent-tool.ts`、Host 原生工具注册。
  - 验证：同步、后台和能力缺失降级逻辑已实现；原生首轮 fake 测试通过。

- [x] 2.3 修复原生首轮事件竞态
  - 状态：DONE
  - 约束：先订阅实时事件，再检查快照，并按事件序号去重。
  - 验证：覆盖首轮在订阅前完成的 fake 测试，事件从 `event.data` 正确读取。

### 阶段检查 2

- [x] 2.4 Subagent 生命周期门禁
  - 状态：DONE
  - 通过标准：Provider 注册去重，disposer 和 Registry holder 在停用时清空；普通 Host 无 `subagents/tools` 服务时仍可启动。

## 阶段 3：清理与最终验证

- [x] 3.1 清理 PR 生成物和旧元数据
  - 状态：DONE
  - 约束：不引入 `.playwright-cli/`、`graphify-out/`；保留当前版本文件。

- [x] 3.2 完成完整验证
  - 状态：DONE
  - 命令：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`、`git diff --check`；全部通过，`pnpm test` 为 905/905。

- [x] 3.3 最终兼容性复核
  - 状态：DONE
  - 通过标准：PR 价值已移植，主线版本、权限、附件、PeerHost 和现有适配器行为无回退；证据见 `docs/开发记录/20260930-spec007.2外部Agent适配器PR代码移植与主线兼容修复.md`。

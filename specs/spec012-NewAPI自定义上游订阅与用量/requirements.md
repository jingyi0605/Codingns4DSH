# 需求文档 - New-API 自定义上游订阅与用量

状态：已完成

## 简介

CodingNS 已支持部分自定义 Base URL 的 Sub2API 用量查询。New-API 的普通 API Key 可以读取 Token 级额度、累计用量和到期时间，但没有通过同一 Key 提供稳定的按日、按模型和用户订阅详情接口。本功能需要接入 New-API 的真实字段，同时保证 Sub2API 的原有解析和展示完全独立。

## 术语表

- **New-API**：QuantumNous/new-api 及其兼容 Fork，提供 OpenAI 兼容接口和 Token/billing 查询接口。
- **Sub2API 读取器**：现有 `Sub2ApiUsageService`，解析 `/v1/usage` 的按日、按模型和缓存统计。
- **New-API 读取器**：只解析 New-API 专用 Token/billing 接口的 Host 侧服务。
- **自定义来源**：Agent 配置中的 Base URL 和 API Key/API Token，凭据只在 Host 内使用。

## 范围说明

### In Scope

- 读取 `/api/usage/token`、`/v1/dashboard/billing/subscription` 和 `/v1/dashboard/billing/usage`。
- 显示余额或剩余额度、累计用量、到期时间、Token 是否有效和 New-API Token 元数据。
- 缺少按日、按模型或用户订阅接口时显示“上游未提供”，不生成虚构数据。
- 扩展 DSH、Codex、Claude Code、OpenCode、Grok、Command Code、ZCode 等已有自定义 Provider 来源发现。
- 保持 Sub2API 的 `/v1/usage`、按日、按模型和缓存命中率路径不变。

### Out of Scope

- CLIProxyAPI Management API、Usage Keeper 或 Provider 专属 quota 的接入。
- 使用用户登录 Cookie、管理员 Token 或浏览器会话抓取 New-API 用户日志和订阅详情。
- 把一次模型响应推算成累计或按日用量。

## 需求

### 需求 1：New-API 读取与字段合并

**用户故事：** 作为使用 New-API 自定义 Base URL 的用户，我希望在对话底部看到真实余额、累计用量和有效期。

#### 验收标准

1. WHEN 自定义来源是 New-API 且 `/api/usage/token` 成功 THEN System SHALL 读取 Token 额度、有效状态、模型限制和到期时间。
2. WHEN billing 接口可用 THEN System SHALL 合并 billing 余额上限和累计用量，并保留 Token 接口更精确的剩余额度。
3. WHEN 同一个接口字段缺失或返回无限额度标记 THEN System SHALL 保留可确认字段，不能把无限额度或缺失值误显示成普通固定余额。
4. WHEN New-API 认证失败或响应结构无法识别 THEN System SHALL 返回空结果，不回退到官方订阅或 Sub2API。

### 需求 2：数据边界与 UI 展示

**用户故事：** 作为用户，我希望看见上游真实提供的数据，并能区分缺失数据和零值。

#### 验收标准

1. WHEN New-API 没有按日或按模型统计 THEN System SHALL 显示“上游未提供”，不得创建零值明细。
2. WHEN New-API 没有用户登录态订阅详情或当前分组 THEN System SHALL 不使用普通 API Key 猜测订阅计划或分组。
3. WHEN New-API 返回 Token 到期时间 THEN System SHALL 显示本地化的到期时间或永久有效状态。
4. WHEN Host 向 Client 投影结果 THEN System SHALL 不包含 API Key、Cookie、JWT 或原始响应。

### 需求 3：自定义来源扩展与兼容

**用户故事：** 作为使用不同外部 Agent 的用户，我希望同一套 New-API 读取逻辑适用于所有支持自定义 Provider 的适配器。

#### 验收标准

1. WHEN DSH、Codex、Claude Code、OpenCode、Grok、Command Code 或 ZCode 能从本地配置解析自定义 Base URL 和凭据 THEN System SHALL 尝试 New-API 读取器。
2. WHEN来源被识别为 Sub2API THEN System SHALL 只进入 Sub2API 读取器，New-API 探测失败不得改变既有结果。
3. WHEN来源既不是 New-API 也不是 Sub2API THEN System SHALL 保留现有官方 Provider 读取和空结果策略。
4. WHEN适配器没有可安全读取的自定义凭据 THEN System SHALL 跳过该来源，不阻塞其他适配器。

## 非功能需求

### 非功能需求 1：性能

1. 单次读取 SHALL 复用统一订阅查询超时，默认不超过现有 8 秒配置。
2. New-API 的多个只读接口 SHALL 在同一 AbortSignal 下并发或快速短路，避免串行放大延迟。

### 非功能需求 2：可靠性

1. 任一可选 billing 接口失败时，只要 Token 接口有效，仍 SHALL 返回已确认的 Token 额度。
2. New-API 读取失败 SHALL 不影响 Sub2API、官方 Provider 和其他 Agent 读取器。

### 非功能需求 3：可维护性

1. New-API 解析器 SHALL 独立于 `Sub2ApiUsageService`，不同响应契约不得共用硬性字段校验。
2. 所有凭据解析和上游请求 SHALL 位于 Host，测试 SHALL 验证结果中不出现密钥。

## 成功定义

- New-API 测试夹具能展示余额、累计用量、到期时间和有效状态。
- Sub2API 现有测试全部保持通过，并新增测试证明两种读取器互不影响。
- 所有适配器的自定义来源发现有明确测试或可解释的不支持原因。

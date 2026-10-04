# 设计文档 - New-API 自定义上游订阅与用量

状态：已完成

## 1. 核心边界

Sub2API 和 New-API 是两套不同的上游协议，不能通过“先请求一个接口，失败后把响应当成另一种格式”混用。来源解析只负责提供 `{ baseUrl, apiKey }`；协议识别和字段归一化由各自读取器负责。

## 2. New-API 读取流程

```text
自定义来源
   │
   ├─ GET /api/usage/token
   │    └─ Token 额度、有效状态、模型限制、expires_at
   ├─ GET /v1/dashboard/billing/subscription
   │    └─ 余额上限、access_until
   └─ GET /v1/dashboard/billing/usage
        └─ 累计用量
              │
              ▼
      ProviderBalanceUsage
```

`/api/usage/token` 是主接口。billing 接口是补充数据源，单个失败不应让已取得的 Token 额度失效。所有请求共用读取超时和 AbortSignal。

## 3. 字段映射

### 3.1 余额和累计用量

- `remaining`：优先使用 Token 响应的 `remaining` 或 `total_available`。
- `total`：优先使用 `total_granted`；缺失时使用 billing 的 hard/soft limit，但无限额度不转换为固定余额。
- `used`：优先使用 Token 的 `total_used`；缺失时使用 billing `total_usage` 的已确认单位转换。
- `unit`：只使用上游明确返回的 `unit`、`currency` 或展示类型；没有明确单位时保持 `null`，并在详情中显示“上游单位未明确”。
- `planName`：只使用 Token 名称或明确的计划字段，不把 group 名称猜成订阅计划。

### 3.2 订阅和到期时间

`expires_at`、`access_until` 统一为 Unix 秒。`0` 或 `-1` 表示永久有效；正数按浏览器本地时区显示。用户登录态的 `/api/subscription/self` 不在普通 API Key 读取范围内，因此不读取、不伪造订阅窗口。

### 3.3 缺失数据

`ProviderBalanceUsage` 中无法确认的数字保持 `null`。UI 使用统一的“上游未提供”文案；不把缺失的按日或按模型统计填成零。

## 4. 来源发现

保留现有各 Agent 的本地配置读取规则，并把来源列表交给 New-API 和 Sub2API 两个独立入口。DSH、Codex、Claude Code、OpenCode、Grok 使用已有配置解析；Command Code 和 ZCode 只有在本地配置确实包含可读 Base URL 与凭据时才加入，不读取无法安全解密或没有自定义地址的官方账号。

## 5. 兼容策略

1. `ProviderSubscriptionService` 先根据来源特征调用 New-API 读取器；命中 New-API 后不调用 Sub2API。
2. 命中 Sub2API 时只调用 `Sub2ApiUsageService`；不修改其归一化、缓存命中率和按日/按模型字段。
3. 两种读取器都失败时按原有官方 Provider 回退规则处理；第三方来源失败不能显示官方订阅。
4. New-API 响应中出现额外字段只做向前兼容解析，不把原始响应下发 Client。

## 6. 测试策略

- New-API 成功、部分 billing 失败、认证失败、无限额度、永久有效、过期时间和脱敏夹具。
- Sub2API 原有测试不改语义，并增加来源隔离测试。
- DSH、Codex、Claude Code、OpenCode、Grok 的来源解析测试；Command Code、ZCode 覆盖“有自定义来源才读取、无来源安全跳过”。
- 运行 typecheck、version check、capability check 和完整测试。

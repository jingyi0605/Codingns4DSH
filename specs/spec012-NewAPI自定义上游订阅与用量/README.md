# spec012：New-API 自定义上游订阅与用量

状态：已完成

## 这份 Spec 解决什么问题

当前自定义 Base URL 的订阅读取全部进入 Sub2API 读取器。New-API 使用独立的 Token 用量和 billing 接口，不能按 `/v1/usage` 解析；如果复用 Sub2API，会把余额、累计用量和有效期误判为无数据，或者破坏已有按日、按模型统计。

本 Spec 为 New-API 增加独立读取器，保留 Sub2API 原有行为，并把自定义来源发现扩展到已有适配器能够配置 Provider 的范围。

## 阅读顺序

1. `requirements.md`：用户可见能力和不可伪造的数据边界。
2. `design.md`：读取优先级、契约映射和适配器来源发现。
3. `tasks.md`：按阶段执行并回写验证证据。
4. `docs/`：New-API 接口调查和实现记录。

## 范围

覆盖 New-API Token 用量、billing 余额/累计用量/到期时间读取、自定义 Provider 来源发现、ProviderBalance 展示和测试。

不覆盖 CLIProxyAPI 管理端配额集成；其管理接口需要独立 Management Key，且版本和 Provider 差异过大。

# 外部 Agent 设置 PeerHost 列表切换与刷新实现记录

## 核心判断

✅ 值得做。插件设置原先没有明确的 Host 选择，而无参数的 Agent 目录查询可能跟随前台工作区；查看、刷新和本机启用操作可能面对不同的目录来源。

## 关键洞察

- 数据结构：目录、安装状态、版本、命令路径和模型目录属于同一台 Host，不能只用 Agent ID 区分来源。
- 复杂度：复用既有 `peerHost/list` 和 `peerHost/request`，不增加远端接口，也不要求先添加工作区或打开会话。
- 风险点：切换 Host 后的迟到响应、远端刷新覆盖本机展示，以及误把本机启用操作发送给远端。

## 实现方案

1. `src/client/features/cli-adapters.ts` 在代理列表标题旁增加 Host 选择器，默认选择本机。开启 PeerHost 模块后读取已登记主机；选择器获得焦点或页面恢复焦点时更新主机列表，没有长期后台轮询。
2. `src/client/cli-settings-rpc.ts` 提供按 Host 绑定的 RPC（远程过程调用）客户端。本机目录显式携带 `catalogHostId: 'local'`；远端目录经既有 HostScope（主机作用域）代理访问 `cli/catalog`、`cli/catalog/refresh` 和 `cli/models`，凭据仍由 Host 保存。
3. 远端查询使用 `__aggregate__` 主机级作用域，不依赖可见工作区。HTTP（超文本传输协议）代理和目标 Fetch 入口沿用已有白名单、登录验证及响应信封。
4. Host 切换立即清空列表与详情，并为每次选择创建独立请求上下文。即使 A → B → A 返回同一台 Host，早期列表、刷新和模型结果也不能覆盖当前展示。
5. 顶部刷新重新检测所选 Host 的全部 Agent，行内刷新只检测指定 Agent。刷新完成后作废对应远端 Host 的模型缓存并通知目录消费者。
6. 详情增加所属 Host，保留安装状态、启用状态、版本、命令路径、协议、能力、诊断及模型目录；模型读取失败在详情中显示原因。
7. 远端启用状态只展示，不提供启用修改；切换远端时隐藏本机子代理托管配置。本机启用操作和托管设置保持原有行为。
8. 主机列表、目录和模型读取传入 10 秒超时信号；检测刷新传入 120 秒超时信号。`PeerHostManagementApi.list` 和 `PeerHostScopedClient.request` 新增可选取消信号，不改变原有调用方式。

## 可用性与兼容边界

- 当前支持已连接的局域网 PeerHost；已有中转 PeerHost 数据面仍不可用，面板显示原因并禁用刷新。
- `session_required` 状态允许发起查询，复用 Host 已有的票据恢复；认证失败保留真实登录原因。
- 主机列表读取失败不影响本机 Agent；远端失败不会替换为本机目录，也不会显示成成功的空目录。
- 旧版 Host 缺少检测刷新时沿用既有不支持提示，不把普通读取伪装成重新检测成功。
- 选择器刷新发现所选 Host 已被移除时恢复本机；停用 PeerHost 模块后停止读取主机列表。
- 对话工具栏仍按会话／导航选择 Host；设置页选择不修改前台导航。

## 验证结果

以下源码回归共 **83 项测试通过**，覆盖真实注册表检测、HTTP 白名单、目标 RPC 信封、旧通道回退、多 Host 隔离、本机导航隔离、迟到结果、只读限制、主机列表变化和失败展示：

```bash
node --import ./tests/register-source-loader.mjs --test \
  tests/cli-settings-peer-host.spec.ts \
  tests/peer-host-model-navigation.spec.ts \
  tests/cli-catalog-refresh.spec.ts \
  tests/client-model-catalog-scope.spec.ts \
  tests/peer-host-contracts.spec.ts \
  tests/peer-host-http-proxy.spec.ts \
  tests/peer-host-integration.spec.ts \
  tests/peer-host-management.spec.ts
```

以下检查通过：

```bash
pnpm run typecheck
pnpm run i18n:check
pnpm run version:check
pnpm run capability:check
git diff --check
```

国际化检查无阻断项，保留已有异常／日志中文告警。验证仅在源码与内存夹具中执行，没有构建产物、启动或重启 Stage0，也没有操作 Desktop、dsh-web、远端实际配置、提交或发布。

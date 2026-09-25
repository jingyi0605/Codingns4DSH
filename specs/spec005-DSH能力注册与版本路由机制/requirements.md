# 需求文档 - DSH 能力注册与版本路由机制

状态：技术规划完成，待实施。

## 简介

DSH 0.1.5、0.1.6 和 0.1.7 的公开 API 存在真实差异。当前插件已经通过 `FeatureRegistry` 管理功能模块，但 DSH 版本差异仍直接出现在模块和入口代码中，导致以下问题：

- 同一能力需要在多个文件重复写版本判断。
- 一个 DSH 版本升级可能同时影响设置、UI、RPC 和 Typert。
- 新功能无法声明自己依赖哪些 DSH 能力，只能在启动后自行失败。
- 旧 DSH 接口何时可以删除没有机器可验证的依据。
- 支持矩阵、package manifest、测试版本和代码实现可能互相不一致。

本 Spec 为插件维护者和功能模块开发者提供一套集中、可扩展、可审计的能力路由机制。

## 术语表

- **DSH 能力（Capability）**：插件可使用的一项稳定宿主能力，例如 `settings.store` 或 `connection.rpc`。
- **能力路由（Route）**：某个 DSH 版本范围和运行时探测条件下，提供一项能力的适配器实现。
- **能力注册表（Capability Registry）**：收集路由、选择实现、生成诊断信息的中心组件。
- **能力画像（Capability Profile）**：一次 Host 或 Client 启动后选定的所有能力实现及其状态。
- **FeatureRegistry**：现有功能模块生命周期注册表，负责依赖、启停和资源释放；它不是本 Spec 要替换的对象。
- **退休（Retirement）**：某条旧能力路由达到移除条件，不再进入构建和运行时矩阵。

## 范围说明

### In Scope

- 建立统一的 DSH 能力 ID、路由、版本范围和探测契约。
- 为 Host、Client 和未来功能模块提供稳定的内部能力接口。
- 将设置、Connection RPC、UI 图标、Locale、Theme、Conversation、Sidebar 和 Typert 纳入能力矩阵。
- 将能力要求接入现有 FeatureRegistry。
- 生成兼容性诊断、测试矩阵和旧接口退休依据。

### Out of Scope

- 不在本 Spec 中重写终端、Transport、认证、文件或反向代理业务逻辑。
- 不改变 DSH 官方 API 的行为，不在插件中复制 DSH runtime。
- 不立即移除 DSH 0.1.5 或 0.1.6；旧适配器只有在退休条件满足后才删除。
- 不启动开发服务器，不执行 npm 发布、Git tag 或 GitHub Release。

## 需求

### 需求 1：集中维护 DSH 能力矩阵

**用户故事：** 作为插件维护者，我希望在一个注册表中声明每项 DSH 能力的版本范围、实现和生命周期，以便新增版本时不再修改多处条件分支。

#### 验收标准

1. WHEN 注册一个能力路由 THEN System SHALL 为其保存稳定能力 ID、适用 DSH 范围、运行端、优先级、探测函数和适配器工厂。
2. WHEN Host 或 Client 启动 THEN System SHALL 根据运行时 DSH 版本和注入服务只选择一个确定的路由，并记录选择结果。
3. WHEN 同一能力没有可用路由或出现多个同优先级候选 THEN System SHALL 返回结构化错误，不得静默选择。

### 需求 2：功能模块只依赖 CodingNS 内部能力接口

**用户故事：** 作为功能模块开发者，我希望模块只依赖稳定的 CodingNS 服务，以便 DSH API 变化只影响适配器，不影响业务模块。

#### 验收标准

1. WHEN 功能模块声明能力需求 THEN System SHALL 在模块启动前完成能力解析。
2. WHEN 能力可用 THEN System SHALL 向模块提供统一的内部接口，例如 `CodingNsSettingsStore`、`CodingNsRpc` 或 `CodingNsIconSet`。
3. WHEN DSH 适配器发生替换 THEN System SHALL 保证未使用 DSH 私有类型的功能模块无需修改。

### 需求 3：能力缺失必须按声明降级

**用户故事：** 作为用户，我希望 DSH 版本缺少某个可选能力时插件仍可启动，以便单个新功能不会拖垮整个 DSH。

#### 验收标准

1. WHEN 模块声明 `required` 能力不可用 THEN System SHALL 阻止该模块启动，并显示能力 ID、当前 DSH 版本和缺失原因。
2. WHEN 模块声明 `fallback: degrade` THEN System SHALL 启用兼容实现或降级行为，并在能力画像中记录降级状态。
3. WHEN 模块声明 `fallback: disable` THEN System SHALL 保持其他模块运行，只禁用当前模块。

### 需求 4：支持 DSH 0.1.5、0.1.6 和 0.1.7 的单版本路由

**用户故事：** 作为插件用户，我希望同一个插件版本覆盖已支持的 DSH 版本，以便升级 DSH 时不必同步更换插件。

#### 验收标准

1. WHEN 运行在 DSH `0.1.5-rc.3`、`0.1.6-alpha.2` 或 `0.1.7-rc.2` THEN System SHALL 选择对应适配器并完成 Host/Client 装配。
2. WHEN DSH 版本位于声明范围内但某项能力不存在 THEN System SHALL 只影响声明该能力的模块。
3. WHEN DSH 版本超出声明范围 THEN System SHALL 在模块导入前或启动门禁阶段给出明确拒绝原因。

### 需求 5：旧能力必须有证据链后才能退休

**用户故事：** 作为维护者，我希望旧 DSH 接口的删除有明确依据，以便减少死代码而不破坏仍在使用的 DSH 用户。

#### 验收标准

1. WHEN 能力路由被标记为弃用 THEN System SHALL 记录替代能力、弃用版本、计划移除版本和当前使用模块。
2. WHEN 修改插件最低 DSH 版本 THEN System SHALL 验证没有功能模块仍依赖被移除的旧路由。
3. WHEN 旧路由被删除 THEN System SHALL 同步更新能力矩阵、manifest、版本文件、文档和测试矩阵。

### 需求 6：兼容性信息必须可诊断和可测试

**用户故事：** 作为排障人员，我希望知道某个模块为什么没有启动以及选中了哪个 DSH 适配器，以便不靠阅读源码定位问题。

#### 验收标准

1. WHEN 能力解析完成 THEN System SHALL 提供能力 ID、选择的路由、DSH 版本、状态和降级原因。
2. WHEN 模块启动被阻止 THEN System SHALL 输出机器可读错误码和用户可读说明。
3. WHEN 执行版本检查和测试 THEN System SHALL 校验 manifest、能力矩阵、依赖版本和测试矩阵的一致性。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 一个 Host 或 Client 启动 THEN System SHALL 只解析一次能力画像，功能模块读取缓存结果，不重复探测。
2. WHEN 功能模块读取能力 THEN System SHALL 使用 O(1) 能力 ID 查找，不在模块间遍历版本规则。

### 非功能需求 2：可靠性

1. WHEN 能力探测抛出异常 THEN System SHALL 将该路由标记为不可用，并尝试同能力的下一候选路由。
2. WHEN 没有候选路由可用 THEN System SHALL 保留清晰的失败原因，不得返回半初始化服务。

### 非功能需求 3：可维护性

1. WHEN 新增 DSH 版本或能力 THEN System SHALL 只要求增加能力路由、适配器、矩阵条目和测试，不允许在业务模块中新增版本分支。
2. WHEN 移除旧 DSH 版本 THEN System SHALL 能通过静态检查发现旧能力 ID、旧适配器和旧依赖引用。
3. WHEN 维护者查看能力矩阵 THEN System SHALL 能追踪到对应源码、测试和文档。

## 成功定义

- 设置、Connection RPC、图标、Locale、Theme、Conversation、Sidebar 和 Typert 均通过能力注册表路由。
- 现有功能模块不再直接导入 DSH 版本相关类型或自行判断 DSH 版本。
- 一个插件版本可以在 DSH 0.1.5、0.1.6、0.1.7 测试矩阵中完成可用能力装配。
- 删除旧能力时有矩阵、测试、manifest 和文档证据，且版本检查可以阻止漏改。

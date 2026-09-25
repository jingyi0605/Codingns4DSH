# 设计文档 - DSH 能力注册与版本路由机制

状态：技术规划完成，待实施。

## 1. 概述

### 1.1 目标

- 用一个能力注册表集中维护 DSH 版本、公开 API 能力和适配器路由。
- 让现有和未来 Feature 只依赖 CodingNS 内部能力接口，不直接依赖 DSH 版本差异。
- 让 Host 与 Client 在启动时生成一次能力画像，并将能力结果路由给 FeatureRegistry。
- 让旧 DSH 接口的弃用、退休和删除都有可验证的记录。

### 1.2 覆盖需求

- `requirements.md` 需求 1：集中维护 DSH 能力矩阵。
- `requirements.md` 需求 2：功能模块只依赖 CodingNS 内部能力接口。
- `requirements.md` 需求 3：能力缺失降级。
- `requirements.md` 需求 4：单版本支持 DSH 0.1.5、0.1.6、0.1.7。
- `requirements.md` 需求 5：旧能力退休。
- `requirements.md` 需求 6：诊断和测试。

### 1.3 技术约束

- 后端：TypeScript、Node.js、Cordis、DSH Host Plugin API。
- 前端：TypeScript、React、DSH Client Plugin API。
- 现有生命周期：继续使用 `FeatureRegistry` 管理模块依赖、启停和资源释放。
- 版本解析：复用并扩展现有 `src/shared/contracts/version.ts`，不在业务模块重复实现 semver。
- 数据存储：能力画像只存在于当前 Host/Client 进程；兼容矩阵是源码中的静态声明，可由脚本生成检查报告。
- 外部依赖：DSH 0.1.5-rc.3、0.1.6-alpha.2、0.1.7-rc.2 的公开包和运行时注入服务。
- 安全约束：能力探测只能检查运行时接口，不得信任客户端 payload 自报的版本或 peer 身份。

## 2. 架构

### 2.1 系统结构

```text
DSH Host/Client 启动
        │
        ▼
RuntimeVersion + 注入服务 + 能力探测
        │
        ▼
DshCapabilityRegistry
        │  选择每个能力的唯一 Route
        ▼
DshCapabilityProfile
        │
        ├── CodingNsSettingsStore
        ├── CodingNsConnectionRpc
        ├── CodingNsIconSet
        ├── CodingNsLocale
        ├── CodingNsTheme
        └── Conversation/Sidebar/Typert 能力
        │
        ▼
FeatureRegistry
        │  检查 Feature requires
        ▼
Host/Client 功能模块
```

能力注册表是 DSH 适配层，`FeatureRegistry` 是业务模块生命周期层。两者职责不能混合：能力注册表不负责启动业务资源，FeatureRegistry 不负责解析 DSH 版本。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `DshCapabilityRegistry` | 注册路由、选择适配器、生成诊断 | DSH 版本、运行时 Context | `DshCapabilityProfile` |
| `DshCompatibilityMatrix` | 声明能力版本范围和生命周期 | 静态路由定义 | 可检查的矩阵 |
| Host adapters | 把 Host DSH API 转成 CodingNS 内部服务 | Host Context | Host capability service |
| Client adapters | 把 Client DSH API 转成 CodingNS 内部服务 | Client Context | Client capability service |
| `DshCapabilityProfile` | 缓存一次启动的能力结果 | Registry resolution | capability lookup |
| `FeatureRegistry` | 检查能力要求并管理模块 | Profile、Feature descriptor | 模块状态和资源 |
| Compatibility diagnostics | 输出选择、降级、拒绝和退休信息 | Profile、Feature 状态 | 日志、测试、诊断 DTO |
| Version checker | 校验矩阵与 package/version 文件 | 矩阵、manifest、lockfile | 通过或失败 |

### 2.3 关键流程

#### 2.3.1 启动时解析能力画像

1. Host/Client 入口读取真实 DSH 版本。
2. 入口创建对应端的 `DshCapabilityRegistry`，注册所有候选路由。
3. 注册表按能力 ID 分组，先过滤 DSH 版本范围，再执行 `detect(context)`。
4. 每个能力只允许选出一个最高优先级路由；同优先级冲突或无路由时生成明确错误。
5. 注册表冻结 `DshCapabilityProfile`，后续 Feature 只读取缓存，不重复探测。
6. `FeatureRegistry` 根据每个模块的 `requires` 检查能力，决定启用、降级或禁用。

#### 2.3.2 新增一个功能模块

1. 开发者先确认需要的能力 ID，不直接导入 DSH 包。
2. 在 Feature descriptor 的 `requires` 中声明必需和可选能力。
3. Feature 从 `context.services.capabilities` 获取内部接口。
4. 在能力矩阵中补充能力使用者和测试场景。
5. 增加至少一个真实 DSH 版本的路由测试和一个缺失能力测试。
6. 不修改设置页、入口分支或公共 RPC switch。

#### 2.3.3 新增一个 DSH 版本路由

1. 先在 `docs/20260925-技术规划与能力矩阵.md` 记录 API 差异。
2. 只为变化的能力新增 adapter route。
3. 保持相同的内部能力接口和 Feature 代码。
4. 将新版本加入 Host/Client fixture 矩阵。
5. 通过构建、类型检查和真实 Profile 回放后，才更新 `version.json` 和 manifest 范围。

#### 2.3.4 退休旧 DSH 能力

1. 将路由状态改为 `deprecated`，记录替代路由和 `removableAfter`。
2. 搜索并确认没有 Feature、测试或导出继续依赖旧能力 ID。
3. 提高插件最低 DSH 版本，更新兼容矩阵和安装检查。
4. 删除旧 adapter、旧类型桥和旧测试。
5. 运行退休检查，确认旧符号、旧包版本和旧路由没有残留。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、6。

- `DshCapabilityRegistry`：能力路由的唯一选择入口。
- `DshCapabilityRoute`：单项能力适配器的声明和工厂。
- `DshCapabilityProfile`：冻结后的能力服务和解析结果。
- `DshCompatibilityMatrix`：能力、版本、适配器和生命周期的静态矩阵。
- `CodingNsCapabilityServices`：Feature 可以使用的内部能力接口集合。
- `FeatureCapabilityRequirement`：Feature 对能力的声明式依赖。

### 3.2 数据结构

#### 3.2.1 `DshCapabilityId`

```ts
export type DshCapabilityId =
  | 'settings.store'
  | 'connection.rpc'
  | 'connection.peer'
  | 'ui.icon.plus'
  | 'ui.icon.chevron'
  | 'locale.runtime'
  | 'theme.runtime'
  | 'conversation.tool-call'
  | 'sidebar.right'
  | 'typert.remote'
```

能力 ID 一旦发布不得改名。若接口语义不兼容，应新增能力 ID 或增加内部契约版本，不得让同一 ID 表示两个不兼容的返回结构。

#### 3.2.2 `DshCapabilityRoute`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `id` | `string` | 是 | 适配器唯一名称 | 同一能力内唯一 |
| `capability` | `DshCapabilityId` | 是 | 提供的能力 | 必须在中心目录注册 |
| `supportedDsh` | `string` | 是 | DSH semver 范围 | 只能由版本工具解析 |
| `runtime` | `'host' \| 'client'` | 是 | 适配器承载端 | 与注册表端一致 |
| `priority` | `number` | 是 | 候选优先级 | 同范围不得产生同优先级冲突 |
| `detect` | `(ctx) => boolean` | 是 | 运行时能力探测 | 只能读，不得修改 Context |
| `create` | `(ctx) => T` | 是 | 构造内部服务 | 失败必须带 route id |
| `status` | `'supported' \| 'deprecated'` | 是 | 生命周期状态 | deprecated 仍可用于旧 DSH |
| `introducedIn` | `string` | 是 | 首次支持版本 | 合法 semver |
| `removableAfter` | `string` | 否 | 可删除的最低宿主版本 | 删除前必须完成退休检查 |
| `replacement` | `DshCapabilityId` | 否 | 替代能力 | deprecated 时建议填写 |

#### 3.2.3 `DshCapabilityResolution`

```ts
export interface DshCapabilityResolution<T> {
  readonly capability: DshCapabilityId
  readonly routeId: string
  readonly dshVersion: string
  readonly status: 'ready' | 'degraded' | 'unavailable'
  readonly value?: T
  readonly reason?: string
  readonly replacement?: DshCapabilityId
}
```

#### 3.2.4 `DshCapabilityProfile`

```ts
export interface DshCapabilityProfile {
  readonly dshVersion: string
  readonly capabilities: ReadonlyMap<DshCapabilityId, DshCapabilityResolution<unknown>>
  readonly diagnostics: readonly DshCapabilityDiagnostic[]
  readonly frozenAt: number
}
```

Profile 创建后不可变。需要重新选择适配器时，必须创建新 Profile，不得在功能运行期间替换单项服务。

#### 3.2.5 `FeatureCapabilityRequirement`

```ts
export interface FeatureCapabilityRequirement {
  readonly capability: DshCapabilityId
  readonly required: boolean
  readonly fallback?: 'disable' | 'degrade' | 'error'
}
```

`FeatureDescriptor.minimumDshVersion` 保留一个迁移周期，之后改为由能力要求表达；新模块不得继续新增裸版本字段。

### 3.3 接口契约

#### 3.3.1 `DshCapabilityRegistry`

- 类型：Function/Class。
- 标识：`DshCapabilityRegistry`。
- 输入：运行时 DSH 版本、Host/Client Context、静态路由。
- 输出：冻结的 `DshCapabilityProfile`。
- 校验：能力 ID、版本范围、运行端、优先级和同能力冲突。
- 错误：`CAPABILITY_INVALID_ROUTE`、`CAPABILITY_VERSION_UNSUPPORTED`、`CAPABILITY_DETECT_FAILED`、`CAPABILITY_ROUTE_CONFLICT`。

核心方法：

```ts
register<T>(route: DshCapabilityRoute<T>): void
resolve(): DshCapabilityProfile
require<T>(profile: DshCapabilityProfile, id: DshCapabilityId): T
explain(profile: DshCapabilityProfile, id?: DshCapabilityId): readonly DshCapabilityDiagnostic[]
```

#### 3.3.2 `CodingNsCapabilityServices`

- 类型：内部 Function/Service 集合。
- 标识：`context.services.capabilities`。
- 输入：能力 ID和内部类型参数。
- 输出：已选 adapter 提供的稳定接口。
- 校验：能力不存在或状态不是 `ready/degraded` 时抛出结构化错误。
- 错误：`CAPABILITY_UNAVAILABLE`、`CAPABILITY_DEGRADED`。

业务模块只能调用这个接口，不能保存 DSH Context 或直接读取 DSH 版本。

#### 3.3.3 `FeatureRegistry` 能力门禁

- 类型：Function/Class 扩展。
- 标识：`FeatureDescriptor.requires`。
- 输入：模块能力要求、`DshCapabilityProfile`。
- 输出：启动、降级、禁用及原因。
- 校验：必需能力必须 ready；可选能力按 fallback 处理。
- 错误：`FEATURE_CAPABILITY_MISSING`、`FEATURE_CAPABILITY_DEGRADED`。

现有 `FeatureRegistry` 仍负责资源和状态，不把能力路由逻辑复制进去。

#### 3.3.4 能力诊断接口

- 类型：Function/RPC-safe DTO。
- 标识：`capabilities/describe`（仅诊断使用，不作为业务依赖）。
- 输入：可选能力 ID或 Feature 名称。
- 输出：DSH 版本、路由、状态、原因、替代项和使用模块。
- 校验：不返回凭据、完整配置值或内部 Context。
- 错误：无能力 ID时返回空结果，不影响插件启动。

## 4. 数据与状态模型

### 4.1 数据关系

```text
CompatibilityMatrix 1 ── * CapabilityRoute
CapabilityRoute 1 ── 1 CapabilityResolution
CapabilityProfile 1 ── * CapabilityResolution
FeatureDescriptor 1 ── * FeatureCapabilityRequirement
FeatureRegistry 1 ── 1 CapabilityProfile
```

静态矩阵描述“允许什么”，能力画像描述“本次实际选了什么”，Feature 状态描述“模块最终是否使用了什么”。三者不混用。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `registered` | 路由已登记 | 加载静态矩阵 | 解析开始 |
| `candidate` | 版本范围匹配 | semver 过滤通过 | 探测成功或失败 |
| `ready` | 能力可用 | 探测和工厂成功 | Profile 销毁 |
| `degraded` | 使用兼容或降级实现 | fallback 被接受 | 新 Profile 替换 |
| `unavailable` | 没有可用实现 | 所有候选失败 | 新 Profile 替换 |
| `deprecated` | 路由仍可用但计划退休 | 矩阵状态标记 | 删除或恢复状态 |
| `retired` | 路由已从代码和矩阵删除 | 退休条件满足 | 不可恢复，新增路由替代 |

## 5. 错误处理

### 5.1 错误类型

- `CAPABILITY_INVALID_ROUTE`：路由声明字段非法。
- `CAPABILITY_VERSION_UNSUPPORTED`：当前 DSH 版本没有匹配路由。
- `CAPABILITY_DETECT_FAILED`：运行时探测抛出异常。
- `CAPABILITY_ROUTE_CONFLICT`：同能力出现同优先级可用路由。
- `CAPABILITY_UNAVAILABLE`：Feature 要求的能力不可用。
- `FEATURE_CAPABILITY_MISSING`：模块启动门禁失败。
- `CAPABILITY_RETIREMENT_BLOCKED`：仍有模块、测试或 manifest 引用旧路由。

### 5.2 错误响应格式

```ts
interface DshCapabilityDiagnostic {
  readonly code: string
  readonly capability: DshCapabilityId
  readonly routeId?: string
  readonly dshVersion: string
  readonly message: string
  readonly replacement?: DshCapabilityId
  readonly featureNames?: readonly string[]
}
```

### 5.3 处理策略

1. 路由声明错误：启动前失败，禁止生成半有效 Profile。
2. 版本不匹配：返回不可用诊断；由 Feature 的 fallback 决定是否继续。
3. 探测异常：记录 route 级原因，尝试同能力下一候选。
4. 业务模块失败：由现有 FeatureRegistry 释放资源，不能污染其他模块。
5. 旧能力退休阻塞：版本同步脚本失败，不允许更新最低 DSH 版本。

## 6. 正确性属性

### 6.1 属性 1：同一能力单一选择

对于任何 DSH 版本和运行时 Context，一个能力 ID 最多只能产生一个有效路由。

**验证需求：** `requirements.md` 需求 1、需求 6。

### 6.2 属性 2：能力画像冻结

对于任何已经启动的 Feature，后续 Context 注入变化不会替换其正在使用的能力实例；必须通过新 Profile 和受控重启完成替换。

**验证需求：** `requirements.md` 需求 2、非功能需求 2。

### 6.3 属性 3：Feature 不直接依赖 DSH 版本

对于任何新 Feature，其启动逻辑只允许读取 `context.services.capabilities` 和声明式 `requires`，不允许读取 DSH 版本或直接导入版本专属 API 类型。

**验证需求：** `requirements.md` 需求 2、非功能需求 3。

### 6.4 属性 4：退休前无残留引用

对于任何标记为 retired 的路由，源码、测试、manifest、能力矩阵和文档中都不得存在有效引用。

**验证需求：** `requirements.md` 需求 5。

## 7. 测试策略

### 7.1 单元测试

- 路由版本匹配、优先级、冲突和缺失能力。
- `detect` 异常后的候选回退。
- Profile 冻结、`require` 和诊断输出。
- Feature capability gate 的启用、降级、禁用和资源清理。
- 退休检查和矩阵/manifest 同步。

### 7.2 集成测试

- DSH 0.1.5-rc.3、0.1.6-alpha.2、0.1.7-rc.2 的 Host/Client fake Context。
- 旧 SettingsScope 与新 ConfigForm 的同一内部 store 行为一致性。
- Connection peer-aware 和旧 handler 的共存。
- 图标适配器在新旧导出集合中的选择。
- Typert、Conversation、Sidebar 公开能力的实际注入。

### 7.3 端到端测试

- 真实 Profile 加载时能力画像与 manifest 一致。
- 设置页在三套 DSH 版本中读取、写入和处理 revision 冲突。
- 缺少可选能力时其他模块仍能启动。
- 超出 DSH 范围时插件在模块导入前被拒绝。
- retired 路由从代码和构建产物中消失。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2、§3.2、§3.3.1 | Registry 单测、矩阵同步检查 |
| 需求 2 | §2.2、§3.3.2 | Feature 编译边界和适配器集成测试 |
| 需求 3 | §3.3.3、§5 | 缺能力、降级和资源清理测试 |
| 需求 4 | §2.3.1、§7.2 | 三版本 fake/真实 Profile 回放 |
| 需求 5 | §2.3.4、§6.4 | retirement guard 和静态引用检查 |
| 需求 6 | §3.3.4、§5.2 | 诊断 DTO、日志和 version:check |

## 8. 风险与待确认项

### 8.1 风险

- DSH 0.1.7 的 `Config`、ConfigForm 和注入生命周期可能需要以真实 Profile 回放校正，不能只依赖声明文件。
- 现有 `@deepseek-ai/dsh-*` 依赖是固定 0.1.6，单版本支持前必须确认 DSH Loader 的注入与 package resolution 规则。
- 图标导出使用 namespace fallback 时需要确认 tsdown/rolldown 的 external 行为，避免构建期被错误 tree-shake。
- Host/Client 共享 TypeScript Context 会放大类型模块合并差异，内部能力类型必须与 DSH 类型隔离。

### 8.2 待确认项

- DSH 0.1.7 稳定版发布后，最终能力范围是否包含 `0.1.7-rc.2` 还是只接受稳定 `0.1.7`。
- 是否把能力诊断暴露为用户可见的设置页诊断入口，还是只保留日志和测试接口。
- 当前 `FeatureDescriptor.minimumDshVersion` 的兼容迁移周期是否定为一个插件小版本。

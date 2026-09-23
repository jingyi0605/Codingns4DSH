export type FeatureState = 'disabled' | 'enabling' | 'enabled' | 'draining' | 'failed'

/** 功能模块的承载端：Host 进程、浏览器，或两端都需要。 */
export type FeatureRuntime = 'host' | 'client' | 'both'

/**
 * 功能模块在设置界面中的静态描述。
 *
 * 它是设置页渲染卡片的唯一来源：卡片标题、说明文字、排序、初始展开状态和
 * 开关可见性都从这里读取，因此新增模块不需要修改设置页代码。
 */
export interface FeatureUiDescriptor {
  /** 设置卡片标题。 */
  label: string
  /** 设置卡片说明。 */
  description: string
  /** DSH locale 命名空间中的标题键；未提供时使用 label 原文。 */
  labelKey?: string
  /** DSH locale 命名空间中的说明键；未提供时使用 description 原文。 */
  descriptionKey?: string
  /** 排序权重，升序靠前；缺省按 0 处理。 */
  order?: number
  /** 卡片初始是否展开。 */
  defaultOpen?: boolean
  /** 启动即生效、不提供关闭入口的模块；设置页只展示当前的启用状态。 */
  alwaysEnabled?: boolean
}

export interface FeatureDescriptor {
  /** 稳定标识：同时作为依赖引用名与设置中的启用键。 */
  name: string
  version: string
  enabledByDefault: boolean
  dependencies: string[]
  runtime: FeatureRuntime
  /** 提供后该模块出现在设置页；缺省表示它没有界面。 */
  ui?: FeatureUiDescriptor
}

/** 模块启动期间可登记的资源释放函数。 */
export type FeatureDisposer = () => void | Promise<void>

/** 以逆序释放模块所拥有资源的集合。 */
export interface FeatureResourceScope {
  add(disposer: FeatureDisposer): void
  dispose(): Promise<void>
  readonly disposed: boolean
}

/**
 * 模块的运行上下文。
 *
 * @typeParam S - 宿主创建注册表时注入的服务集合。
 */
export interface FeatureContext<S = unknown> {
  readonly descriptor: FeatureDescriptor
  readonly resources: FeatureResourceScope
  readonly services: S
}

/** 可由模块注册表管理的功能模块。 */
export interface FeatureModule<S = unknown> {
  descriptor: FeatureDescriptor
  start(context: FeatureContext<S>): void | FeatureDisposer | Promise<void | FeatureDisposer>
  drain?(context: FeatureContext<S>): void | Promise<void>
  dispose?(context: FeatureContext<S>): void | Promise<void>
}

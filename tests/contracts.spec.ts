import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS_MODULES_FIELD,
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_CONTROL_BASE_URL,
  DEFAULT_CODINGNS_SETTINGS,
  DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS,
  DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
  DEFAULT_FILE_MANAGEMENT_SETTINGS,
  DEFAULT_MOBILE_ACCESS_SETTINGS,
  DEFAULT_SUBSCRIPTION_USAGE_SETTINGS,
  CODINGNS_DSH_ERROR_CODES,
  CodingNsDshError,
  isDshVersionCompatible,
  isDshVersionAtLeast,
  isLegacyDshVersion,
  minimumSupportedDshVersion,
  SUPPORTED_DSH_VERSION,
  assertSupportedDshVersion,
  enabledFeatureNames,
  isFeatureDshVersionCompatible,
  captureRestartFeatureStates,
  isFeatureEnabled,
  normalizeMobileAccessSettings,
  type FeatureDescriptor,
} from '../data/build/dist/shared/index.js'

function descriptorOf(name: string, options: {
  enabledByDefault?: boolean
  alwaysEnabled?: boolean
  disabled?: boolean
} = {}): FeatureDescriptor {
  return {
    name,
    version: '1.0.0',
    enabledByDefault: options.enabledByDefault ?? false,
    dependencies: [],
    runtime: 'client',
    ...(options.disabled === true ? { disabled: true } : {}),
    ...(options.alwaysEnabled === true
      ? { ui: { label: name, description: `${name} 说明`, alwaysEnabled: true } }
      : {}),
  }
}

test('Codingns4DSH 设置用模块名字典表达开关，结构不随模块数量变化', () => {
  assert.equal(CODINGNS_SETTINGS_NAMESPACE, 'codingns')
  assert.equal(CODINGNS_MODULES_FIELD, 'modules')
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS, {
    controlBaseUrl: DEFAULT_CODINGNS_CONTROL_BASE_URL,
    controlBaseUrls: [DEFAULT_CODINGNS_CONTROL_BASE_URL],
    modules: {},
    agentAdapters: {},
    agentAdapterPreferences: {},
    terminalEnhancement: DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
    workspaceSessionEnhancement: DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
    fileManagement: DEFAULT_FILE_MANAGEMENT_SETTINGS,
    mobileAccess: DEFAULT_MOBILE_ACCESS_SETTINGS,
    subscriptionUsage: DEFAULT_SUBSCRIPTION_USAGE_SETTINGS,
    lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0, pwa: DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS },
  })
})

test('移动端访问设置缺省回填、越界收敛', () => {
  // 默认开启：DSH 原生折叠态仍占 56px 轨道，手机上一开始就该收掉。
  const defaultMobileAccess = {
    hideSidebarOnMobile: true,
    optimizeSettingsOnMobile: true,
    mobileViewportMaxPx: 1024,
    sidebarGestures: true,
    sidebarGestureMapping: 'swipe-inward',
    sidebarGestureEdge: 'avoid',
    sidebarGestureThresholdPx: 64,
  }
  assert.deepEqual(DEFAULT_MOBILE_ACCESS_SETTINGS, defaultMobileAccess)
  assert.deepEqual(normalizeMobileAccessSettings(undefined), DEFAULT_MOBILE_ACCESS_SETTINGS)
  assert.deepEqual(normalizeMobileAccessSettings({}), DEFAULT_MOBILE_ACCESS_SETTINGS)
  assert.deepEqual(normalizeMobileAccessSettings({ hideSidebarOnMobile: false }), { ...defaultMobileAccess, hideSidebarOnMobile: false })
  // 越界值收敛到允许范围，非法类型回落到默认值。
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 10 }), { ...defaultMobileAccess, mobileViewportMaxPx: 480 })
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 99999 }), { ...defaultMobileAccess, mobileViewportMaxPx: 1280 })
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 'wide' }), defaultMobileAccess)
  // 非对象输入不能抛出，也不能把字符串当成真值开关。
  assert.deepEqual(normalizeMobileAccessSettings('on'), defaultMobileAccess)
  assert.deepEqual(normalizeMobileAccessSettings({ hideSidebarOnMobile: 'yes' }), { ...defaultMobileAccess, hideSidebarOnMobile: false })
  assert.deepEqual(normalizeMobileAccessSettings({}, { sidebarGestures: false, sidebarGestureMapping: 'swap' }), {
    ...defaultMobileAccess,
    sidebarGestures: false,
    sidebarGestureMapping: 'swap',
  })
})

test('重启生效模块固定使用进程启动时捕获的状态', () => {
  const terminal = {
    ...descriptorOf('terminalEnhancement'),
    activation: 'restart' as const,
  }
  const descriptors = [terminal, descriptorOf('reverseProxy')]
  const started = { ...DEFAULT_CODINGNS_SETTINGS, modules: { terminalEnhancement: false, reverseProxy: false } }
  const restartStates = captureRestartFeatureStates(descriptors, started)

  const changed = { ...started, modules: { terminalEnhancement: true, reverseProxy: true } }
  assert.deepEqual(enabledFeatureNames(descriptors, changed, restartStates), ['reverseProxy'])
  assert.deepEqual(restartStates, { terminalEnhancement: false })
})

test('用户没有表达意图时使用模块自己的 enabledByDefault', () => {
  assert.equal(isFeatureEnabled(descriptorOf('terminal', { enabledByDefault: true }), undefined), true)
  assert.equal(
    isFeatureEnabled(descriptorOf('terminal', { enabledByDefault: true }), DEFAULT_CODINGNS_SETTINGS),
    true,
  )
  assert.equal(isFeatureEnabled(descriptorOf('reverseProxy'), undefined), false)
})

test('用户意图覆盖 enabledByDefault，常驻模块无法被关闭', () => {
  assert.equal(
    isFeatureEnabled(descriptorOf('reverseProxy'), { ...DEFAULT_CODINGNS_SETTINGS, modules: { reverseProxy: true } }),
    true,
  )
  assert.equal(
    isFeatureEnabled(descriptorOf('lanAccess', { enabledByDefault: true, alwaysEnabled: true }), {
      ...DEFAULT_CODINGNS_SETTINGS,
      modules: { lanAccess: false },
    }),
    true,
  )
})

test('维护停用模块忽略历史 enabled 设置', () => {
  const descriptor = descriptorOf('peerHost', { disabled: true })
  const settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { peerHost: true } }
  assert.equal(isFeatureEnabled(descriptor, settings), false)
  assert.deepEqual(enabledFeatureNames([descriptor], settings), [])
})

test('enabledFeatureNames 汇总当前应当启用的模块', () => {
  const descriptors = [
    descriptorOf('lanAccess', { enabledByDefault: true, alwaysEnabled: true }),
    descriptorOf('auth', { enabledByDefault: true }),
    descriptorOf('reverseProxy'),
  ]

  assert.deepEqual(enabledFeatureNames(descriptors, undefined), ['lanAccess', 'auth'])
  assert.deepEqual(
    enabledFeatureNames(descriptors, { ...DEFAULT_CODINGNS_SETTINGS, modules: { reverseProxy: true, auth: false } }),
    ['lanAccess', 'reverseProxy'],
  )
})

test('共享出口不再暴露按模块枚举的配置结构', async () => {
  const shared = await import('../data/build/dist/shared/index.js')
  assert.equal(typeof shared.isFeatureEnabled, 'function')
  assert.equal(typeof shared.enabledFeatureNames, 'function')
  assert.equal('parseCodingNsDshConfig' in shared, false)
  assert.equal('CODINGNS_SETTINGS_FIELD' in shared, false)
})

test('不兼容 DSH 版本给出稳定错误码', () => {
  assert.doesNotThrow(() => assertSupportedDshVersion(SUPPORTED_DSH_VERSION))
  assert.equal(isDshVersionCompatible('0.2.0-rc.1'), false)
  assert.equal(isDshVersionCompatible('0.2.0-rc.2'), true)
  assert.equal(isDshVersionCompatible('0.2.0'), false)
  assert.equal(isDshVersionCompatible('0.3.0'), false)
  assert.equal(isDshVersionCompatible('0.1.7-rc.2'), false)
  assert.equal(isLegacyDshVersion('0.1.5-rc.3'), true)
  assert.equal(isLegacyDshVersion('0.1.6-alpha.2'), false)
  assert.throws(
    () => assertSupportedDshVersion('0.1.8'),
    (error) => error instanceof CodingNsDshError
      && error.code === CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
  )
})

test('缺少注入时的回退版本取自兼容范围下界且始终在范围内', () => {
  const fallback = minimumSupportedDshVersion()
  assert.equal(fallback, '0.2.0-rc.2')
  // 回退值必须能通过同一套门禁：它一旦落在范围外，缺注入的页面就会被
  // 误报为“不支持的 DSH 版本”，而真实原因只是启动页没有注入。
  assert.doesNotThrow(() => assertSupportedDshVersion(fallback))
  assert.equal(isDshVersionCompatible(fallback), true)
})

test('模块版本门禁阻止旧设置在 rc3 上启动 alpha2 专属模块', () => {
  const workspace = {
    ...descriptorOf('workspaceSessionEnhancement', { enabledByDefault: false }),
    minimumDshVersion: '0.1.6-alpha.2',
  }
  const settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { workspaceSessionEnhancement: true } }
  assert.equal(isDshVersionAtLeast('0.1.5-rc.3', '0.1.6-alpha.2'), false)
  assert.equal(isFeatureDshVersionCompatible(workspace, '0.1.5-rc.3'), false)
  assert.deepEqual(enabledFeatureNames([workspace], settings, undefined, '0.1.5-rc.3'), [])
  assert.deepEqual(enabledFeatureNames([workspace], settings, undefined, '0.1.6-alpha.2'), ['workspaceSessionEnhancement'])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS_MODULES_FIELD,
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_CONTROL_BASE_URL,
  DEFAULT_CODINGNS_SETTINGS,
  DEFAULT_ASSISTANT_SETTINGS,
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
  assert.equal(DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showSkillQuickReference, true)
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS, {
    controlBaseUrl: DEFAULT_CODINGNS_CONTROL_BASE_URL,
    controlBaseUrls: [DEFAULT_CODINGNS_CONTROL_BASE_URL],
    modules: {},
    agentAdapters: {},
    agentAdapterPreferences: {},
    subagentBridge: { enabled: false, maxConcurrentSubagents: 8 },
    terminalEnhancement: DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
    workspaceSessionEnhancement: DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
    fileManagement: DEFAULT_FILE_MANAGEMENT_SETTINGS,
    mobileAccess: DEFAULT_MOBILE_ACCESS_SETTINGS,
    subscriptionUsage: DEFAULT_SUBSCRIPTION_USAGE_SETTINGS,
    assistant: DEFAULT_ASSISTANT_SETTINGS,
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
    sidebarGestureDistancePercent: 25,
  }
  assert.deepEqual(DEFAULT_MOBILE_ACCESS_SETTINGS, defaultMobileAccess)
  assert.deepEqual(normalizeMobileAccessSettings(undefined), DEFAULT_MOBILE_ACCESS_SETTINGS)
  assert.deepEqual(normalizeMobileAccessSettings({}), DEFAULT_MOBILE_ACCESS_SETTINGS)
  assert.deepEqual(normalizeMobileAccessSettings({ hideSidebarOnMobile: false }), { ...defaultMobileAccess, hideSidebarOnMobile: false })
  // 越界值收敛到允许范围，非法类型回落到默认值。
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 10 }), { ...defaultMobileAccess, mobileViewportMaxPx: 480 })
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 99999 }), { ...defaultMobileAccess, mobileViewportMaxPx: 1280 })
  assert.deepEqual(normalizeMobileAccessSettings({ mobileViewportMaxPx: 'wide' }), defaultMobileAccess)
  // 手势比例越界收敛：低于 15% 夹到 15%，高于 80% 夹到 80%。
  assert.deepEqual(normalizeMobileAccessSettings({ sidebarGestureDistancePercent: 5 }), { ...defaultMobileAccess, sidebarGestureDistancePercent: 15 })
  assert.deepEqual(normalizeMobileAccessSettings({ sidebarGestureDistancePercent: 95 }), { ...defaultMobileAccess, sidebarGestureDistancePercent: 80 })
  assert.deepEqual(normalizeMobileAccessSettings({ sidebarGestureDistancePercent: 55 }), { ...defaultMobileAccess, sidebarGestureDistancePercent: 55 })
  // 非对象输入不能抛出，也不能把字符串当成真值开关。
  assert.deepEqual(normalizeMobileAccessSettings('on'), defaultMobileAccess)
  assert.deepEqual(normalizeMobileAccessSettings({ hideSidebarOnMobile: 'yes' }), { ...defaultMobileAccess, hideSidebarOnMobile: false })
  assert.deepEqual(normalizeMobileAccessSettings({}, { sidebarGestures: false, sidebarGestureMapping: 'swap' }), {
    ...defaultMobileAccess,
    sidebarGestures: false,
    sidebarGestureMapping: 'swap',
  })
})

test('旧像素门槛一次性迁移为视口比例', () => {
  // 旧实现的有效阈值是 max(像素值, 视口宽度 × 40%)：低于该下限的像素值从未生效，
  // 用户实际一直在用 40% 的默认手感。这类旧值迁移到新默认 25%，才能获得灵敏度修复。
  for (const legacyPx of [24, 48, 64, 80, 97]) {
    assert.equal(
      normalizeMobileAccessSettings({ sidebarGestureThresholdPx: legacyPx }).sidebarGestureDistancePercent,
      25,
      `未生效的旧值 ${legacyPx}px 迁移后应落到新默认值`,
    )
  }
  // 高于新默认值的旧值按 390px 参考视口线性换算，并保持「旧值越大越严格」的单调性。
  for (const [legacyPx, expectedPercent] of [[120, 31], [140, 36], [156, 40], [195, 50], [200, 51]] as const) {
    assert.equal(
      normalizeMobileAccessSettings({ sidebarGestureThresholdPx: legacyPx }).sidebarGestureDistancePercent,
      expectedPercent,
      `旧值 ${legacyPx}px 应换算为 ${expectedPercent}%`,
    )
  }
  // 新字段优先，旧字段不参与二次换算，避免迁移结果被反复改写。
  assert.equal(
    normalizeMobileAccessSettings({ sidebarGestureDistancePercent: 30, sidebarGestureThresholdPx: 195 }).sidebarGestureDistancePercent,
    30,
  )
  // 旧字段同样支持从 workspaceSessionEnhancement 读取。
  assert.equal(
    normalizeMobileAccessSettings({}, { sidebarGestureThresholdPx: 195 }).sidebarGestureDistancePercent,
    50,
  )
  // 非法旧值不参与换算，回落到默认值。
  assert.equal(normalizeMobileAccessSettings({ sidebarGestureThresholdPx: 'wide' }).sidebarGestureDistancePercent, 25)
  assert.equal(normalizeMobileAccessSettings({ sidebarGestureThresholdPx: -10 }).sidebarGestureDistancePercent, 25)
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
  assert.equal(isDshVersionCompatible('0.2.0'), true)
  assert.equal(isDshVersionCompatible('0.2.1-alpha.1'), true)
  assert.equal(isDshVersionCompatible('0.2.1-beta.1'), false)
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

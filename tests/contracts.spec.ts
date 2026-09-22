import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS_MODULES_FIELD,
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_SETTINGS,
  CODINGNS_DSH_ERROR_CODES,
  CodingNsDshError,
  SUPPORTED_DSH_VERSION,
  assertSupportedDshVersion,
  enabledFeatureNames,
  isFeatureEnabled,
  type FeatureDescriptor,
} from '../dist/shared/index.js'

function descriptorOf(name: string, options: {
  enabledByDefault?: boolean
  alwaysEnabled?: boolean
} = {}): FeatureDescriptor {
  return {
    name,
    version: '1.0.0',
    enabledByDefault: options.enabledByDefault ?? false,
    dependencies: [],
    runtime: 'client',
    ...(options.alwaysEnabled === true
      ? { ui: { label: name, description: `${name} 说明`, alwaysEnabled: true } }
      : {}),
  }
}

test('CodingNS 设置用模块名字典表达开关，结构不随模块数量变化', () => {
  assert.equal(CODINGNS_SETTINGS_NAMESPACE, 'codingns')
  assert.equal(CODINGNS_MODULES_FIELD, 'modules')
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS, {
    controlBaseUrl: '',
    modules: {},
    lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
  })
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
  const shared = await import('../dist/shared/index.js')
  assert.equal(typeof shared.isFeatureEnabled, 'function')
  assert.equal(typeof shared.enabledFeatureNames, 'function')
  assert.equal('parseCodingNsDshConfig' in shared, false)
  assert.equal('CODINGNS_SETTINGS_FIELD' in shared, false)
})

test('不兼容 DSH 版本给出稳定错误码', () => {
  assert.doesNotThrow(() => assertSupportedDshVersion(SUPPORTED_DSH_VERSION))
  assert.throws(
    () => assertSupportedDshVersion('0.1.7'),
    (error) => error instanceof CodingNsDshError
      && error.code === CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { isStage0Runtime } from '../data/build/dist/host/stage0-dev-hmr.js'
import { CODINGNS_STAGE0_GLOBAL, isInjectedStage0Runtime } from '../data/build/dist/shared/runtime-environment.js'

test('只有专用 Stage0 启动器的完整环境才开启诊断，普通 npm 运行默认关闭', () => {
  const stage0 = { CODINGNS4DSH_PROFILE_NAME: 'stage0', CODINGNS4DSH_STAGE0_REPO_ROOT: '/test/repo', CODINGNS4DSH_STAGE0_LAUNCHER: '/test/bin.js' }
  assert.equal(isStage0Runtime(stage0), true)
  for (const environment of [{}, { NODE_ENV: 'development' }, { ...stage0, CODINGNS4DSH_PROFILE_NAME: 'web' },
    { ...stage0, CODINGNS4DSH_PROFILE_NAME: 'desktop' }, { ...stage0, CODINGNS4DSH_STAGE0_REPO_ROOT: undefined },
    { ...stage0, CODINGNS4DSH_STAGE0_LAUNCHER: ' ' }, { CODINGNS4DSH_PROFILE_NAME: 'stage0' }]) {
    assert.equal(isStage0Runtime(environment), false)
  }
})

test('浏览器仅接受布尔真值，缺失和历史 Host 注入均按正式环境显示', () => {
  assert.equal(isInjectedStage0Runtime({ [CODINGNS_STAGE0_GLOBAL]: true }), true)
  for (const value of [undefined, null, false, 'true', 'stage0', 1, {}, []]) {
    assert.equal(isInjectedStage0Runtime({ [CODINGNS_STAGE0_GLOBAL]: value }), false)
  }
  assert.equal(isInjectedStage0Runtime({}), false)
})

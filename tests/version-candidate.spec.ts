import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCandidateVersion } from '../scripts/check-version.mjs'

test('历史 tag 只影响相同版本线和发布类型', () => {
  const tags = ['v0.2.2-beta.5', 'v0.2.3-rc.1', 'v0.2.30-beta.3.1']
  assert.equal(checkCandidateVersion('0.2.3-beta.1', tags), undefined)
  assert.equal(checkCandidateVersion('0.2.2-beta.6', tags), undefined)
  assert.match(checkCandidateVersion('0.2.3-beta.2', [...tags, 'v0.2.3-beta.1.1']) ?? '', /历史 tag/u)
})

test('允许稳定版和数字预发布，但拒绝不规范的版本写法', () => {
  assert.equal(checkCandidateVersion('0.2.3', []), undefined)
  assert.equal(checkCandidateVersion('0.2.3-1', []), undefined)
  for (const invalid of ['0.2.3-beta1', '0.2.3.1', '0.2.3-beta.01', 'v0.2.3-beta.1']) {
    assert.match(checkCandidateVersion(invalid, []) ?? '', /版本命名/u, invalid)
  }
})

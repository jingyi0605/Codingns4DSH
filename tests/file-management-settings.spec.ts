import assert from 'node:assert/strict'
import test from 'node:test'
import { fileManagementFeature } from '../data/build/dist/client/features/index.js'
import { isEditableFilePath } from '../data/build/dist/client/file-management-dom.js'
import { DEFAULT_FILE_MANAGEMENT_SETTINGS, DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/index.js'

test('文件管理增强提供菜单、编辑器和会话修改文件子开关', () => {
  assert.equal(fileManagementFeature.descriptor.name, 'fileManagement')
  assert.equal(fileManagementFeature.descriptor.enabledByDefault, false)
  assert.equal(fileManagementFeature.descriptor.runtime, 'client')
  assert.equal(fileManagementFeature.settingsPanel?.name, 'FileManagementPanel')
})

test('文件管理子开关默认同时启用并纳入共享设置契约', () => {
  assert.deepEqual(DEFAULT_FILE_MANAGEMENT_SETTINGS, { menuEnhancement: true, fileEditor: true, sessionChangedFiles: true })
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS.fileManagement, DEFAULT_FILE_MANAGEMENT_SETTINGS)
})

test('文件编辑器识别现代 JavaScript、TypeScript、脚本和常见工程文本文件', () => {
  for (const path of [
    'scripts/check-forbidden-node-sqlite.mjs',
    'scripts/build.cjs',
    'src/config.mts',
    'src/config.cts',
    'scripts/deploy.bash',
    'scripts/deploy.zsh',
    'scripts/deploy.ps1',
    'Dockerfile',
    '.env.local',
    '.gitignore',
  ]) {
    assert.equal(isEditableFilePath(path), true, `${path} 应可编辑`)
  }
  for (const path of ['assets/logo.png', 'documents/manual.pdf', 'archive.zip', 'build/output.bin']) {
    assert.equal(isEditableFilePath(path), false, `${path} 不应被当作文本文件`)
  }
})

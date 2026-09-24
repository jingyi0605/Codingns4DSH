import assert from 'node:assert/strict'
import test from 'node:test'
import { detectTerminalShells, resolveTerminalShell } from '../data/build/dist/host/terminal/shell-detection.js'

test('Linux 缺少 zsh 时系统推荐回退 bash', () => {
  const shells = detectTerminalShells({
    platform: 'linux',
    env: {},
    isExecutable: (path) => path === '/bin/bash',
  })
  assert.deepEqual(shells, [
    { profileId: 'zsh', displayName: 'zsh', path: null, available: false, unavailableReason: '未找到可执行文件' },
    { profileId: 'bash', displayName: 'bash', path: '/bin/bash', available: true },
  ])
  assert.deepEqual(resolveTerminalShell('system', shells, 'linux'), {
    requestedProfileId: 'system',
    resolvedProfileId: 'bash',
    path: '/bin/bash',
  })
})

test('macOS 系统推荐优先选择 zsh', () => {
  const shells = detectTerminalShells({
    platform: 'darwin',
    env: { SHELL: '/custom/zsh' },
    isExecutable: (path) => path === '/custom/zsh' || path === '/bin/bash',
  })
  assert.deepEqual(resolveTerminalShell('system', shells, 'darwin'), {
    requestedProfileId: 'system',
    resolvedProfileId: 'zsh',
    path: '/custom/zsh',
  })
})

test('Windows 只报告实际存在的 PowerShell、cmd 和 Git Bash', () => {
  const installed = new Set([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ])
  const shells = detectTerminalShells({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    isExecutable: (path) => installed.has(path),
  })
  assert.equal(shells.find((shell) => shell.profileId === 'powershell')?.available, false)
  assert.equal(shells.find((shell) => shell.profileId === 'cmd')?.available, true)
  assert.equal(shells.find((shell) => shell.profileId === 'git-bash')?.available, true)
  assert.deepEqual(resolveTerminalShell('powershell', shells, 'win32'), {
    requestedProfileId: 'powershell',
    resolvedProfileId: 'cmd',
    path: 'C:\\Windows\\System32\\cmd.exe',
    fallbackReason: 'powershell 当前不可用，已回退到命令提示符',
  })
})

test('没有支持的 shell 时拒绝创建终端', () => {
  const shells = detectTerminalShells({ platform: 'linux', env: {}, isExecutable: () => false })
  assert.throws(() => resolveTerminalShell('system', shells, 'linux'), /没有可用/)
})

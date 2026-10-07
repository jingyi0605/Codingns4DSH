/** 托管 Python 的环境边界；不继承宿主库路径，管道协议统一使用 UTF-8。 */
export function voiceProcessEnvironment(source: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  const controlled: NodeJS.ProcessEnv = {
    PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    PIP_NO_INPUT: '1', PIP_REQUIRE_VIRTUALENV: 'true',
  }
  const removed = new Set(['PYTHONHOME', 'PYTHONPATH', ...Object.keys(controlled)])
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    // Windows 子进程不区分变量名大小写，必须先删除所有变体再写入规范名称。
    if (!removed.has(platform === 'win32' ? name.toUpperCase() : name)) environment[name] = value
  }
  return { ...environment, ...controlled }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('真实 Python 主循环的诊断先于结算，图耗时覆盖错误，关闭诊断保持旧协议', () => {
  // 只替换模型依赖，直接执行生产主循环和计时代理，不安装依赖或加载真实模型。
  const script = `
import ast, json, sys, time
from pathlib import Path
from types import SimpleNamespace
source = Path(sys.argv[1])
tree = ast.parse(source.read_text(encoding="utf-8"))
nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in ("emit", "diagnostic", "TimedSession", "main")]
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"))
class FakeRuntime:
    def __init__(self, *args, **kwargs): pass
    def resolve_manifest_relative_path(self, value): return value
    manifest = {"model_files": {"tokenizer_model": "fixture"}}
class FakeSession:
    marker = "属性透传"
    def run(self, failing):
        if failing: raise ValueError("fixture failure")
        return [42]
def synthesize(runtime, tokenizer, request):
    session = TimedSession(FakeSession(), runtime, "prefill")
    assert session.marker == "属性透传"
    return {"values": session.run(request.get("fail", False))}
HostRuntime = FakeRuntime
spm = SimpleNamespace(SentencePieceProcessor=lambda **kwargs: None)
main()
`
  const input = [
    { id: 'on', action: 'synthesize', diagnostics: true },
    { id: 'error', action: 'synthesize', diagnostics: true, fail: true },
    { id: 'off', action: 'synthesize', diagnostics: false },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n'
  const stdout = execFileSync(process.env.CODINGNS4DSH_TTS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', script, fileURLToPath(new URL('../assets/moss/worker.py', import.meta.url))], { input, encoding: 'utf8', timeout: 5000 })
  const events = stdout.trim().split('\n').map((line) => JSON.parse(line))
  for (const id of ['on', 'error']) {
    const selected = events.filter((event) => event.id === id)
    assert.equal(selected.at(-1).type, id === 'on' ? 'done' : 'error')
    assert.ok(selected.slice(0, -1).every((event) => event.type === 'diagnostic'))
    const phase = selected.find((event) => event.fields?.phase === 'prefill')
    assert.equal(phase.fields.count, 1)
    assert.ok(phase.fields.durationMs >= 0)
    assert.ok(selected.some((event) => event.fields?.phase === 'request' && event.fields.cpuPercent >= 0))
  }
  assert.deepEqual(events.filter((event) => event.id === 'off').map((event) => event.type), ['done'])
  assert.deepEqual(events.find((event) => event.id === 'on' && event.type === 'done').result.values, [42])
})

"""仅验证工作进程协议；不加载模型，不用于音质或内存验收。"""
import base64
import ast
import json
import os
import sys
import time
from pathlib import Path


# 直接加载生产协议输出函数，不安装或导入模型依赖。
source = Path(__file__).resolve().parents[2] / "assets/moss/worker.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "emit"], type_ignores=[])
exec(compile(functions, str(source), "exec"))


if sys.argv[1] == "fail-start":
    emit({"type": "fatal", "message": "fixture startup failure"})
    sys.exit(1)
if sys.argv[1] == "slow-start":
    time.sleep(0.25)
emit({"type": "ready"})
for line in sys.stdin:
    request = json.loads(line)
    if request.get("hang"):
        time.sleep(10)
    if request.get("fail"):
        emit({"id": request["id"], "type": "error", "message": "fixture request failure：中文错误"})
        continue
    if request["action"] == "encode":
        Path(request["codesPath"]).write_text("中文参考编码", encoding="utf-8")
    if request["action"] == "synthesize":
        if request.get("diagnostics"):
            emit({"id": request["id"], "type": "diagnostic", "fields": {"phase": "prefill", "durationMs": 12, "text": "禁止写入日志"}})
        emit({"id": request["id"], "type": "audio", "data": base64.b64encode(b"\x00\x00\xff\x7f").decode(), "sampleRate": 48000})
    emit({"id": request["id"], "type": "done", "result": {
        "pid": os.getpid(), "voice": request.get("voice"), "text": request.get("text"),
        "codesPath": request.get("codesPath"), "modelDirectory": sys.argv[1],
        "stdinEncoding": sys.stdin.encoding, "stdoutEncoding": sys.stdout.encoding,
        "pythonHome": os.environ.get("PYTHONHOME"), "pythonPath": os.environ.get("PYTHONPATH"),
    }})

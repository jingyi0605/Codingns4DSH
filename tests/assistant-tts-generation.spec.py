"""直接验证生产工作进程中的生成控制；模拟数组与模型，不安装推理依赖。"""
import ast
import base64
import unittest
from pathlib import Path
from types import SimpleNamespace


source = Path(__file__).resolve().parents[1] / "assets/moss/worker.py"
tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
names = {"generation_settings", "text_chunks", "emit_audio", "synthesize"}
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
scope = {"base64": base64, "re": __import__("re")}
exec(compile(functions, str(source), "exec"), scope)


class Samples:
    """数组替身只供控制流测试；不模拟或断言真实音频算法。"""

    def __getitem__(self, key):
        return self

    def mean(self, **kwargs):
        return self

    def __mul__(self, number):
        return self

    def astype(self, dtype):
        return self

    def tobytes(self):
        return b"\x01\x00"


class Runtime:
    def __init__(self, empty_segment=None):
        self.codec_meta = {"codec_config": {"sample_rate": 48000}}
        self.manifest = {"generation_defaults": {"max_new_frames": 375}}
        self.codec_streaming_session = SimpleNamespace(reset=lambda: None, run_frames=lambda frames: (Samples(), 1))
        self.segment = 0
        self.empty_segment = empty_segment

    def list_builtin_voices(self):
        return [{"voice": "Junhao", "prompt_audio_codes": [[1]]}]

    def build_voice_clone_request_rows(self, codes, tokens):
        return tokens

    def generate_audio_frames(self, rows, on_frame):
        current = self.segment
        self.segment += 1
        if current == self.empty_segment:
            return []
        on_frame([[1]], 0, [1])
        return [[1]]


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.seeds = []
        scope["emit"] = self.events.append
        scope["np"] = SimpleNamespace(
            random=SimpleNamespace(default_rng=lambda seed: self.seeds.append(seed) or seed),
            clip=lambda value, *args: value, round=lambda value: value,
        )
        self.tokenizer = SimpleNamespace(encode=lambda text, **kwargs: list(text))

    def test_validation_and_defaults(self):
        read = scope["generation_settings"]
        self.assertEqual(read({}), {"chunkTokens": 75, "segmentPauseMs": 0, "seed": None})
        self.assertEqual(read({"parameters": {"seed": 0}})["seed"], 0)
        for value in ({"chunkTokens": 29}, {"chunkTokens": 120.5}, {"seed": True}, {"seed": -1}, {"segmentPauseMs": 2001}, {"temperature": 0.8}):
            with self.assertRaises(ValueError):
                read({"parameters": value})

    def test_chunk_budget_changes_segments_without_losing_text(self):
        text = "甲" * 96
        split = scope["text_chunks"]
        self.assertEqual([len(item) for item in split(text, self.tokenizer, 30)], [30, 30, 30, 6])
        self.assertEqual([len(item) for item in split(text, self.tokenizer, 75)], [75, 21])
        self.assertEqual("".join(split(text, self.tokenizer, 30)), text)

    def test_pause_only_between_segments_and_seed_resets_per_request(self):
        request = {"id": "test", "text": "甲" * 61, "voice": "Junhao", "parameters": {"chunkTokens": 30, "segmentPauseMs": 100, "seed": 42}}
        runtime = Runtime()
        result = scope["synthesize"](runtime, self.tokenizer, request)
        audio = [base64.b64decode(event["data"]) for event in self.events]
        self.assertEqual([len(item) for item in audio], [2, 9600, 2, 9600, 2])
        self.assertEqual(audio[1], bytes(9600))
        self.assertEqual(result["bytes"], 19206)
        scope["synthesize"](runtime, self.tokenizer, request)
        self.assertEqual(self.seeds, [42, 42])

    def test_inserted_silence_cannot_mask_missing_speech(self):
        request = {"id": "test", "text": "甲" * 61, "voice": "Junhao", "parameters": {"chunkTokens": 30, "segmentPauseMs": 100}}
        with self.assertRaisesRegex(ValueError, "未生成有效音频"):
            scope["synthesize"](Runtime(empty_segment=1), self.tokenizer, request)

    def test_first_audio_is_emitted_after_first_frame_before_generation_finishes(self):
        runtime = Runtime()
        batches = []
        runtime.codec_streaming_session.run_frames = lambda frames: batches.append(len(frames)) or (Samples(), 1)

        def generate(rows, on_frame):
            frames = []
            for index in range(5):
                frames.append([1])
                on_frame(frames, index, [1])
                if index == 0:
                    self.assertEqual(len(self.events), 1, "首音不能等待第二帧或整段生成结束")
            return frames

        runtime.generate_audio_frames = generate
        scope["synthesize"](runtime, self.tokenizer, {"id": "first", "text": "先播放", "voice": "Junhao"})
        self.assertEqual(batches, [1, 2, 2], "首帧后恢复双帧批量解码，避免持续增加 CPU 开销")


if __name__ == "__main__":
    unittest.main()

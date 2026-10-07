#!/usr/bin/env python3
"""Host 专用 CPU 工作进程；只使用 ONNX、NumPy 和音频处理库，不加载 PyTorch。"""
import base64
import json
import math
import os
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
import sentencepiece as spm
import soundfile as sf
from scipy.signal import resample_poly
from ort_cpu_runtime import OrtCpuRuntime


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def diagnostic(request, phase, **fields):
    """诊断只发标量耗时，由 Host 批量写文件，不在 Python 同步操作磁盘。"""
    if request.get("diagnostics"):
        emit({"id": request["id"], "type": "diagnostic", "fields": {"phase": phase, **fields}})


class TimedSession:
    """聚合每张 ONNX 图的调用时间，不逐 token 输出日志。"""

    def __init__(self, session, runtime, phase):
        self.session = session
        self.runtime = runtime
        self.phase = phase

    def __getattr__(self, name):
        return getattr(self.session, name)

    def run(self, *args, **kwargs):
        metrics = getattr(self.runtime, "diagnostic_timings", None)
        if metrics is None:
            return self.session.run(*args, **kwargs)
        started = time.perf_counter()
        try:
            return self.session.run(*args, **kwargs)
        finally:
            count, duration = metrics.get(self.phase, (0, 0.0))
            metrics[self.phase] = (count + 1, duration + (time.perf_counter() - started) * 1000)


class HostRuntime(OrtCpuRuntime):
    """只创建实际使用的图，避免加载完整解码和多种局部解码的重复权重。"""

    def _session(self, path_value):
        options = ort.SessionOptions()
        options.intra_op_num_threads = self.thread_count
        options.inter_op_num_threads = 1
        options.enable_mem_pattern = False
        session = ort.InferenceSession(str(path_value), sess_options=options, providers=["CPUExecutionProvider"])
        return TimedSession(session, self, Path(path_value).stem)

    def _create_sessions(self):
        tts = self.tts_meta_path.parent
        codec = self.codec_meta_path.parent
        return {
            "prefill": self._session(tts / self.tts_meta["files"]["prefill"]),
            "decode": self._session(tts / self.tts_meta["files"]["decode_step"]),
            "local_fixed_sampled_frame": self._session(tts / self.tts_meta["files"]["local_fixed_sampled_frame"]),
            "codec_decode_step": self._session(codec / self.codec_meta["files"]["decode_step"]),
        }

    def encode_reference(self, audio_path, codes_path):
        info = sf.info(audio_path)
        if info.samplerate < 8000 or info.samplerate > 192000 or info.channels not in (1, 2):
            raise ValueError("参考录音的采样率或声道不支持")
        if not 2 <= info.duration <= 30:
            raise ValueError("参考录音需要 2～30 秒；请选取清晰的单人短录音")
        audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
        if not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 0.0001:
            raise ValueError("参考录音无有效声音")
        target_rate = int(self.codec_meta["codec_config"]["sample_rate"])
        if rate != target_rate:
            factor = math.gcd(rate, target_rate)
            audio = resample_poly(audio, target_rate // factor, rate // factor, axis=0).astype(np.float32)
        channels = int(self.codec_meta["codec_config"]["channels"])
        if channels == 1:
            audio = audio.mean(axis=1, keepdims=True)
        elif audio.shape[1] == 1:
            audio = np.repeat(audio, channels, axis=1)
        waveform = np.clip(audio.T[None, :, :], -1, 1).astype(np.float32)
        # 编码图仅导入时加载，生成时无需常驻额外权重。
        encoder = self._session(self.codec_meta_path.parent / self.codec_meta["files"]["encode"])
        outputs = encoder.run(None, {"waveform": waveform, "input_lengths": np.asarray([waveform.shape[-1]], dtype=np.int32)})
        named = dict(zip((item.name for item in encoder.get_outputs()), outputs, strict=True))
        length = int(named["audio_code_lengths"].reshape(-1)[0])
        if length <= 0:
            raise ValueError("参考录音编码为空")
        codes = named["audio_codes"][0, :length, :].astype(np.int32).tolist()
        target = Path(codes_path)
        temporary = target.with_suffix(".part")
        temporary.write_text(json.dumps(codes), encoding="utf-8")
        os.replace(temporary, target)
        return {"duration": info.duration, "sampleRate": info.samplerate}


def generation_settings(request):
    """只接收固定 ONNX 图真正支持的生成控制，不虚设采样参数。"""
    settings = {"chunkTokens": 75, "segmentPauseMs": 0, "seed": None}
    supplied = request.get("parameters", {})
    if not isinstance(supplied, dict) or any(key not in settings for key in supplied):
        raise ValueError("生成参数无效")
    settings.update(supplied)
    for key, minimum, maximum in (("chunkTokens", 30, 120), ("segmentPauseMs", 0, 2000), ("seed", 0, 4294967295)):
        value = settings[key]
        if key == "seed" and value is None:
            continue
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"生成参数 {key} 超出范围")
    return settings


def text_chunks(text, tokenizer, token_limit=75):
    """按指定 token 预算分块，优先在标点后结束，默认沿用官方推荐值。"""
    remaining = text.strip()
    while remaining:
        end = min(len(remaining), 240)
        while end > 1 and len(tokenizer.encode(remaining[:end], out_type=int)) > token_limit:
            end -= 1
        if end < len(remaining):
            boundaries = [match.end() for match in re.finditer(r"[。！？!?；;,，\n ]", remaining[:end])]
            if boundaries and boundaries[-1] >= end // 2:
                end = boundaries[-1]
        yield remaining[:end].strip()
        remaining = remaining[end:].strip()


def emit_audio(request, pcm, rate):
    emit({"id": request["id"], "type": "audio", "data": base64.b64encode(pcm).decode("ascii"), "sampleRate": rate})
    return len(pcm)


def synthesize(runtime, tokenizer, request):
    parameters = generation_settings(request)
    # 每次请求建立自己的随机序列，固定种子不受此前试听和其他音色请求影响。
    runtime.rng = np.random.default_rng(parameters["seed"])
    if request.get("codesPath"):
        codes = json.loads(Path(request["codesPath"]).read_text(encoding="utf-8"))
    else:
        voice = next((voice for voice in runtime.list_builtin_voices() if voice["voice"] == request.get("voice")), None)
        if voice is None:
            raise ValueError("内置音色不存在")
        codes = voice["prompt_audio_codes"]
    rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
    emitted = 0
    for index, text in enumerate(text_chunks(request["text"], tokenizer, parameters["chunkTokens"])):
        segment_started = time.perf_counter()
        codec_ms = 0.0
        chunks = 0
        if index > 0 and parameters["segmentPauseMs"] > 0:
            pause = bytes(rate * parameters["segmentPauseMs"] // 1000 * 2)
            emitted += emit_audio(request, pause, rate)
        before_segment = emitted
        runtime.codec_streaming_session.reset()
        rows = runtime.build_voice_clone_request_rows(codes, tokenizer.encode(text, out_type=int))
        pending = []

        def flush():
            nonlocal emitted, codec_ms, chunks
            if not pending:
                return
            codec_started = time.perf_counter()
            decoded = runtime.codec_streaming_session.run_frames(pending[:])
            codec_ms += (time.perf_counter() - codec_started) * 1000
            pending.clear()
            if decoded is None:
                return
            audio, length = decoded
            if length <= 0:
                return
            mono = audio[0, :, :length].mean(axis=0)
            pcm = np.round(np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()
            emitted += emit_audio(request, pcm, rate)
            chunks += 1
            diagnostic(request, "audio_chunk", segment=index, chunks=chunks,
                       audioMs=len(pcm) / 2 / rate * 1000,
                       durationMs=(time.perf_counter() - segment_started) * 1000)

        def on_frame(_frames, _index, frame):
            pending.append(frame)
            # 首帧立即交给因果解码器，后续仍每两帧解码，兼顾首音延迟和 CPU 开销。
            if emitted == before_segment or len(pending) >= 2:
                flush()

        frames = runtime.generate_audio_frames(rows, on_frame=on_frame)
        flush()
        duration_ms = (time.perf_counter() - segment_started) * 1000
        diagnostic(request, "segment", segment=index, textLength=len(text),
                   generationFrames=len(frames), chunks=chunks, codecMs=codec_ms,
                   generationMs=max(0.0, duration_ms - codec_ms), durationMs=duration_ms,
                   audioMs=(emitted - before_segment) / 2 / rate * 1000)
        if emitted == before_segment:
            raise ValueError("模型未生成有效音频")
        if len(frames) >= int(runtime.manifest["generation_defaults"]["max_new_frames"]):
            raise ValueError("生成达到帧数上限，请缩短文本后重试")
    if emitted == 0:
        raise ValueError("模型未生成有效音频")
    return {"bytes": emitted, "sampleRate": rate}


def reference_audio(runtime, request):
    """官方包只保证参考编码，解码试听不依赖未公开或已经变化的原始录音。"""
    voice = next((voice for voice in runtime.list_builtin_voices() if voice["voice"] == request["voice"]), None)
    if voice is None:
        raise ValueError("内置音色不存在")
    runtime.codec_streaming_session.reset()
    chunks = []
    codes = voice["prompt_audio_codes"]
    for index in range(0, len(codes), 8):
        decoded = runtime.codec_streaming_session.run_frames(codes[index:index + 8])
        if decoded is None:
            continue
        audio, length = decoded
        if length > 0:
            mono = audio[0, :, :length].mean(axis=0)
            chunks.append(np.round(np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes())
    if not chunks:
        raise ValueError("预设参考音频为空")
    with wave.open(request["audioPath"], "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(int(runtime.codec_meta["codec_config"]["sample_rate"]))
        output.writeframes(b"".join(chunks))
    return {"ready": True}


def main():
    runtime = HostRuntime(sys.argv[1], thread_count=4, sample_mode="fixed")
    tokenizer = spm.SentencePieceProcessor(model_file=str(runtime.resolve_manifest_relative_path(runtime.manifest["model_files"]["tokenizer_model"])))
    emit({"type": "ready"})
    for line in sys.stdin:
        request = json.loads(line)
        runtime.diagnostic_timings = {} if request.get("diagnostics") else None
        request_started = time.perf_counter()
        request_cpu = time.process_time()
        try:
            if request["action"] == "encode":
                result = runtime.encode_reference(request["audioPath"], request["codesPath"])
            elif request["action"] == "synthesize":
                result = synthesize(runtime, tokenizer, request)
            elif request["action"] == "probe":
                result = {"ready": True}
            elif request["action"] == "reference":
                result = reference_audio(runtime, request)
            else:
                raise ValueError("未知推理动作")
            reply = {"id": request["id"], "type": "done", "result": result}
        except Exception as error:
            reply = {"id": request["id"], "type": "error", "message": str(error)}
        # 诊断先于 done/error，Host 结算之后不能再收到同一请求 ID 的事件。
        if runtime.diagnostic_timings is not None:
            for phase, (count, duration) in runtime.diagnostic_timings.items():
                diagnostic(request, phase, count=count, durationMs=duration)
            duration = time.perf_counter() - request_started
            diagnostic(request, "request", durationMs=duration * 1000,
                       cpuPercent=(time.process_time() - request_cpu) / max(duration, 0.000001) * 100)
        runtime.diagnostic_timings = None
        emit(reply)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "fatal", "message": str(error)})
        sys.exit(1)

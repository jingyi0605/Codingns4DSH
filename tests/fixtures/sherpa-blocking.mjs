/** 模拟原生同步推理耗时，验证它不会占用 Host 的事件循环。 */
export class OnlineRecognizer {
  createStream() { return { ready: false, acceptWaveform() { this.ready = true }, inputFinished() {} } }
  isReady(stream) { return stream.ready }
  decode(stream) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); stream.ready = false }
  getResult() { return { text: '工作线程识别结果' } }
  isEndpoint() { return false }
  reset() {}
}

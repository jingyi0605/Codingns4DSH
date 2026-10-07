/** 用确定的语音／静音时长验证适配层端点配置，不模拟模型准确率。 */
export class OnlineRecognizer {
  constructor(config) { this.silenceSeconds = config.rule2MinTrailingSilence }
  createStream() {
    return { ready: false, text: '', silence: 0,
      acceptWaveform({ samples, sampleRate }) {
        this.ready = true
        if (samples.some((sample) => sample !== 0)) { this.text = '对话测试'; this.silence = 0 }
        else this.silence += samples.length / sampleRate
      }, inputFinished() {} }
  }
  isReady(stream) { return stream.ready }
  decode(stream) { stream.ready = false }
  getResult(stream) { return { text: stream.text } }
  isEndpoint(stream) { return stream.text !== '' && stream.silence >= this.silenceSeconds }
  reset(stream) { stream.text = ''; stream.silence = 0 }
}

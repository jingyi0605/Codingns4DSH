import { sanitizeVoiceText } from '../shared/voice-text.js'

export interface VoiceOutputAdapter {
  speak(text: string, epoch: number): Promise<void> | void
  cancel(): Promise<void> | void
}

/** 播报控制器：每次新播报都会取消旧队列，打断时不会继续播放旧文本。 */
export class VoiceOutputController {
  private epoch = 0

  constructor(private readonly adapter: VoiceOutputAdapter) {}

  async speak(text: string): Promise<number> {
    const normalized = sanitizeVoiceText(text)
    this.epoch += 1
    const epoch = this.epoch
    await this.adapter.cancel()
    if (normalized === '') return epoch
    for (const sentence of splitSentences(normalized)) {
      if (epoch !== this.epoch) return epoch
      await this.adapter.speak(sentence, epoch)
    }
    return epoch
  }

  async interrupt(): Promise<void> {
    this.epoch += 1
    await this.adapter.cancel()
  }

  currentEpoch(): number { return this.epoch }
}

function splitSentences(value: string): readonly string[] {
  return value.split(/(?<=[。！？!?；;。\n])/u).map((item) => item.trim()).filter(Boolean)
}

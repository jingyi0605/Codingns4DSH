import type {
  VoiceClientDevice,
  VoiceClientDeviceManager,
  VoiceClientDeviceSnapshot,
} from '../shared/contracts/voice-runtime.js'
import { inspectBrowserVoiceSecurity } from './voice-security.js'

const INPUT_KEY = 'codingns4dsh.voice.input-device'
const OUTPUT_KEY = 'codingns4dsh.voice.output-device'

/**
 * 浏览器 Client 的设备管理器。
 *
 * 设备权限、设备 ID 和设备变化都属于当前浏览器来源；Host 只会收到选择后的
 * PCM 数据，不会接触这里的真实硬件清单。
 */
export class BrowserVoiceDeviceManager implements VoiceClientDeviceManager {
  private readonly listeners = new Set<(snapshot: VoiceClientDeviceSnapshot) => void>()
  private current: VoiceClientDeviceSnapshot
  private readonly deviceChangeDispose: (() => void) | undefined
  private disposed = false

  constructor() {
    const security = inspectBrowserVoiceSecurity()
    this.current = {
      secureContext: security.secure,
      permission: 'unknown',
      inputs: [],
      outputs: [],
      selectedInputId: readStorage(INPUT_KEY),
      selectedOutputId: readStorage(OUTPUT_KEY),
    }
    const mediaDevices = globalThis.navigator?.mediaDevices
    if (mediaDevices !== undefined && typeof mediaDevices.addEventListener === 'function') {
      const onDeviceChange = (): void => { void this.refresh() }
      mediaDevices.addEventListener('devicechange', onDeviceChange)
      this.deviceChangeDispose = () => mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
    else this.deviceChangeDispose = undefined
  }

  snapshot(): VoiceClientDeviceSnapshot { return cloneSnapshot(this.current) }

  subscribe(listener: (snapshot: VoiceClientDeviceSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<VoiceClientDeviceSnapshot> {
    if (this.disposed) return this.snapshot()
    const security = inspectBrowserVoiceSecurity()
    const mediaDevices = globalThis.navigator?.mediaDevices
    if (!security.secure || mediaDevices === undefined || typeof mediaDevices.enumerateDevices !== 'function') {
      this.update({ secureContext: security.secure, inputs: [], outputs: [] })
      return this.snapshot()
    }
    const devices = await mediaDevices.enumerateDevices()
    const inputs = devices.filter((device) => device.kind === 'audioinput').map(toDevice('audioinput'))
    const outputs = devices.filter((device) => device.kind === 'audiooutput').map(toDevice('audiooutput'))
    const selectedInputId = this.current.selectedInputId !== null && inputs.some((device) => device.deviceId === this.current.selectedInputId)
      ? this.current.selectedInputId
      : null
    const selectedOutputId = this.current.selectedOutputId !== null && outputs.some((device) => device.deviceId === this.current.selectedOutputId)
      ? this.current.selectedOutputId
      : null
    if (selectedInputId === null) removeStorage(INPUT_KEY)
    if (selectedOutputId === null) removeStorage(OUTPUT_KEY)
    this.update({ inputs, outputs, selectedInputId, selectedOutputId })
    await this.refreshPermission()
    return this.snapshot()
  }

  async requestInputPermission(): Promise<VoiceClientDeviceSnapshot> {
    if (this.disposed) throw new Error('语音设备管理器已释放')
    const security = inspectBrowserVoiceSecurity()
    if (!security.secure) throw new Error('当前页面不是安全上下文，请改用 HTTPS 或 localhost 后访问麦克风')
    const mediaDevices = globalThis.navigator?.mediaDevices
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') throw new Error('当前浏览器不支持 getUserMedia')
    const selected = this.current.selectedInputId
    let stream: MediaStream
    try {
      stream = await mediaDevices.getUserMedia({ audio: buildInputConstraints(selected), video: false })
    } catch (error) {
      // 浏览器会在麦克风被拔出、蓝牙设备重建或权限数据变化后保留旧 deviceId。
      // 这时继续使用 exact 约束只会得到 “Requested device not found”，应清掉
      // 失效偏好并回退到系统默认麦克风，让首次点击仍能完成初始化。
      if (selected === null || !isMissingInputDeviceError(error)) throw error
      removeStorage(INPUT_KEY)
      this.update({ selectedInputId: null })
      stream = await mediaDevices.getUserMedia({ audio: buildInputConstraints(null), video: false })
    }
    for (const track of stream.getTracks()) track.stop()
    await this.refresh()
    this.update({ permission: 'granted' })
    return this.snapshot()
  }

  async selectInput(deviceId: string): Promise<VoiceClientDeviceSnapshot> {
    const value = deviceId.trim()
    if (value !== '' && !this.current.inputs.some((device) => device.deviceId === value)) {
      await this.refresh()
      if (!this.current.inputs.some((device) => device.deviceId === value)) throw new Error('选择的麦克风设备不存在')
    }
    if (value === '') removeStorage(INPUT_KEY)
    else writeStorage(INPUT_KEY, value)
    this.update({ selectedInputId: value === '' ? null : value })
    return this.snapshot()
  }

  async selectOutput(deviceId: string): Promise<VoiceClientDeviceSnapshot> {
    const value = deviceId.trim()
    if (value !== '' && !this.current.outputs.some((device) => device.deviceId === value)) {
      await this.refresh()
      if (!this.current.outputs.some((device) => device.deviceId === value)) throw new Error('选择的播放设备不存在')
    }
    if (value === '') removeStorage(OUTPUT_KEY)
    else writeStorage(OUTPUT_KEY, value)
    this.update({ selectedOutputId: value === '' ? null : value })
    return this.snapshot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deviceChangeDispose?.()
    this.listeners.clear()
  }

  private async refreshPermission(): Promise<void> {
    const permissions = globalThis.navigator?.permissions
    if (permissions === undefined || typeof permissions.query !== 'function') return
    try {
      const status = await permissions.query({ name: 'microphone' as PermissionName })
      this.update({ permission: status.state === 'granted' || status.state === 'denied' ? status.state : 'prompt' })
    } catch {
      // 某些浏览器不暴露 microphone 权限查询，不能因此阻断 getUserMedia。
    }
  }

  private update(patch: Partial<VoiceClientDeviceSnapshot>): void {
    this.current = { ...this.current, ...patch }
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* 单个 UI 订阅者异常不能破坏设备生命周期 */ }
    }
  }
}

function buildInputConstraints(selectedInputId: string | null): MediaTrackConstraints {
  return selectedInputId === null
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : {
      deviceId: { exact: selectedInputId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
}

function isMissingInputDeviceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
  return name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError'
}

function toDevice(kind: VoiceClientDevice['kind']): (device: MediaDeviceInfo) => VoiceClientDevice {
  return (device) => ({ kind, deviceId: device.deviceId, label: device.label, groupId: device.groupId })
}

function cloneSnapshot(value: VoiceClientDeviceSnapshot): VoiceClientDeviceSnapshot {
  return { ...value, inputs: [...value.inputs], outputs: [...value.outputs] }
}

function readStorage(key: string): string | null {
  try {
    const value = globalThis.localStorage?.getItem(key)
    return value?.trim() || null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* 隐私模式下允许只保留内存偏好 */ }
}

function removeStorage(key: string): void {
  try { globalThis.localStorage?.removeItem(key) } catch { /* 忽略不可写存储 */ }
}

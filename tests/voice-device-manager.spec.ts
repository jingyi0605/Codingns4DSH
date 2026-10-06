import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserVoiceDeviceManager } from '../data/build/dist/client/voice-device-manager.js'

test('浏览器设备管理器只保存选择并响应设备枚举', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const devices = [
    { kind: 'audioinput', deviceId: 'mic-1', label: '麦克风', groupId: 'group-1' },
    { kind: 'audiooutput', deviceId: 'speaker-1', label: '扬声器', groupId: 'group-1' },
  ] as MediaDeviceInfo[]
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices: async () => devices, addEventListener: () => undefined, removeEventListener: () => undefined } } })
  try {
    const manager = new BrowserVoiceDeviceManager()
    const snapshot = await manager.refresh()
    assert.equal(snapshot.inputs[0]?.deviceId, 'mic-1')
    await manager.selectInput('mic-1')
    assert.equal(manager.snapshot().selectedInputId, 'mic-1')
    await assert.rejects(() => manager.selectInput('missing'), /不存在/u)
    manager.dispose()
  } finally {
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
  }
})

test('失效麦克风偏好会回退到默认设备', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map([['codingns4dsh.voice.input-device', 'stale-mic']])
  let attempts = 0
  const mediaDevices = {
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default-mic', label: '默认麦克风', groupId: 'group-1' }],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      attempts += 1
      const audio = constraints.audio
      if (typeof audio === 'object' && audio !== null && 'deviceId' in audio) {
        const error = new Error('Requested device not found')
        error.name = 'NotFoundError'
        throw error
      }
      return { getTracks: () => [{ stop: () => undefined }] }
    },
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  try {
    const manager = new BrowserVoiceDeviceManager()
    const snapshot = await manager.requestInputPermission()
    assert.equal(snapshot.permission, 'granted')
    assert.equal(snapshot.selectedInputId, null)
    assert.equal(attempts, 2)
    assert.equal(storage.has('codingns4dsh.voice.input-device'), false)
    manager.dispose()
  } finally {
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previousStorage)
  }
})

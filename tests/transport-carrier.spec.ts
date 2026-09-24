import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDataChannelCarrier,
  DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
  DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES,
} from '../data/build/dist/transport/index.js'

class FakeChannel {
  readonly label = 'codingns-tunnel'
  readonly readyState = 'open'
  readonly sent: Uint8Array[] = []
  bufferedAmount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  send(data: ArrayBuffer | ArrayBufferView): void {
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    this.sent.push(new Uint8Array(view))
  }

  close(): void {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  receive(data: Uint8Array): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data } as unknown as MessageEvent<Uint8Array>)
  }
}

test('DataChannel Carrier 对大消息透明分片并在乱序后重组', async () => {
  const senderChannel = new FakeChannel()
  const receiverChannel = new FakeChannel()
  const sender = createDataChannelCarrier(senderChannel)
  const receiver = createDataChannelCarrier(receiverChannel)
  const received: Uint8Array[] = []
  receiver.subscribe((data) => received.push(data))

  const payload = new Uint8Array(616090)
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
  await sender.send(payload)

  assert.equal(senderChannel.sent.length, Math.ceil(payload.byteLength / DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES))
  assert.ok(senderChannel.sent.every((chunk) => chunk.byteLength <= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES + DATA_CHANNEL_FRAGMENT_HEADER_BYTES))
  assert.ok(senderChannel.sent.every((chunk) => chunk[0] === 0x44 && chunk[1] === 0x53 && chunk[2] === 0x46 && chunk[3] === 0x01))

  for (const chunk of [...senderChannel.sent].reverse()) receiverChannel.receive(chunk)
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], payload)
  await sender.close()
  await receiver.close()
})

test('DataChannel Carrier 对 Relay hello 等小消息保持原始单帧', async () => {
  const channel = new FakeChannel()
  const carrier = createDataChannelCarrier(channel)
  const hello = new Uint8Array([0x52, 0x54, 0x57, 0x01])
  await carrier.send(hello)
  assert.deepEqual(channel.sent, [hello])
  await carrier.close()
})

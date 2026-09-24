import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrameDecoder, decodeFrame, encodeFrame, TUNNEL_FRAME_HEADER_BYTES } from '../dist/transport/frame.js'

test('与父仓库 relay-tunnel-wire 的 hello fixture 字节布局一致', () => {
  const frame = encodeFrame({
    type: 'hello',
    clientContext: null,
    protocolVersion: '1',
  })
  const meta = new TextEncoder().encode('{"clientContext":null,"protocolVersion":"1"}')
  assert.equal(frame[0], 1)
  assert.equal(frame[1], 10)
  assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2), meta.byteLength)
  assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(6), 0)
  assert.deepEqual(frame.subarray(TUNNEL_FRAME_HEADER_BYTES), meta)
  assert.deepEqual(decodeFrame(frame), { type: 'hello', clientContext: null, protocolVersion: '1' })
})

test('增量解码兼容父仓库的半帧与粘帧行为', () => {
  const first = encodeFrame({ type: 'ping', at: '2026-09-23T00:00:00.000Z' })
  const second = encodeFrame({ type: 'pong', at: '2026-09-23T00:00:01.000Z' })
  const all = new Uint8Array(first.byteLength + second.byteLength)
  all.set(first); all.set(second, first.byteLength)
  const decoder = createFrameDecoder()
  assert.deepEqual(decoder.push(all.subarray(0, 3)), [])
  assert.deepEqual(decoder.push(all.subarray(3)), [
    { type: 'ping', at: '2026-09-23T00:00:00.000Z' },
    { type: 'pong', at: '2026-09-23T00:00:01.000Z' },
  ])
})

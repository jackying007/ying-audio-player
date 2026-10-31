import { mock } from 'bun:test'
import assert from 'node:assert/strict'

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android' } })
mock.module('@tauri-apps/plugin-fs', () => ({ readFile: async () => {}, readTextFile: async () => {} }))
mock.module('../../src/store/network-settings', () => ({ useNetworkSettings: { getState: () => ({}) } }))

const pending = new Map<number, { size: number; bytes: number[] }>()
let nextId = 0
let chunks = 0
let aborts = 0
let failChunk = process.argv[2] === 'failure'
let failFinish = process.argv[2] === 'finish-failure'
const published: Uint8Array[] = []

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, input: unknown) => {
    // Tauri's Android postMessage path serializes typed arrays inside the JSON envelope.
    const envelope = JSON.stringify({ payload: input }, (_key, value) =>
      value instanceof ArrayBuffer
        ? Array.from(new Uint8Array(value))
        : value instanceof Uint8Array
          ? Array.from(value)
          : value
    )
    const args = JSON.parse(envelope).payload
    if (command.endsWith('|save_cache')) {
      assert(!Array.isArray(args), 'Android converted the complete binary request to JSON; Rust requires a raw body')
      throw new Error('Android must not send the complete audio through save_cache')
    }
    assert(envelope.length < 512 * 1024, 'one IPC packet must remain bounded')
    if (command.endsWith('|begin_cache_write')) {
      const rid = ++nextId
      pending.set(rid, { size: args.size, bytes: [] })
      return rid
    }
    if (command.endsWith('|write_cache_chunk')) {
      const write = pending.get(args.rid)!
      assert(write)
      assert.equal(args.offset, write.bytes.length)
      assert(args.data.length > 0 && args.data.length <= 64 * 1024)
      chunks++
      if (failChunk && chunks === 2) throw new Error('write failed')
      for (const byte of args.data) write.bytes.push(byte)
      return
    }
    if (command.endsWith('|finish_cache_write')) {
      const write = pending.get(args.rid)!
      assert.equal(write.bytes.length, write.size)
      if (failFinish) {
        pending.delete(args.rid)
        throw new Error('commit failed')
      }
      published.push(new Uint8Array(write.bytes))
      pending.delete(args.rid)
      return
    }
    if (command.endsWith('|abort_cache_write')) {
      aborts++
      pending.delete(args.rid)
      return
    }
    throw new Error(`Unexpected command: ${command}`)
  }
}))

const { saveNetworkCache } = await import('../../src/lib/network-cache')
const key = {
  connection: 'a'.repeat(64),
  folderId: 1,
  folderName: '音乐',
  audioId: 1,
  filename: '原版.MP3',
  hash: 'a'.repeat(64),
  lyricsHash: 'b'.repeat(64),
  hasLyrics: true
}
const bytes = Uint8Array.from({ length: 256 * 1024 + 17 }, (_, index) => index % 256)
const lyrics = '[00:01]中文歌词'
const blob = new Blob([bytes])

if (failChunk || failFinish) {
  await assert.rejects(saveNetworkCache(key, blob, lyrics), failChunk ? /write failed/ : /commit failed/)
  assert.equal(aborts, 1)
  assert.equal(published.length, 0)
  assert.equal(pending.size, 0)
  failChunk = false
  failFinish = false
}
await saveNetworkCache(key, blob, lyrics)
assert(chunks > 1)
assert.equal(pending.size, 0)
assert.equal(published.length, 1)
const payload = published[0]
const metadataSize = new DataView(payload.buffer).getUint32(0, true)
assert.deepEqual(JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metadataSize))), { key, lyrics })
assert.deepEqual(payload.subarray(4 + metadataSize), bytes)

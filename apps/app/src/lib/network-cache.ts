import { invoke } from '@tauri-apps/api/core'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { fileHash } from './file-hash'
import { isMobile } from './platform'
import { useNetworkSettings } from '@/store/network-settings'
import type { AudioInfo } from '@/store/audio-store'

export type NetworkCacheKey = {
  connection: string
  folderId: number
  folderName: string
  audioId: number
  filename: string
  hash: string
  lyricsHash: string | null
  hasLyrics: boolean
}

type CachedFiles = { audioPath: string; lyricsPath?: string | null }

export async function networkCacheKey(audio: AudioInfo): Promise<NetworkCacheKey> {
  // Capture credentials before hashing; a configuration change must not relabel an old download.
  const { serverUrl, token } = useNetworkSettings.getState()
  if (!audio.filename || !audio.hash || !audio.folderName || !audio.link.startsWith(`${serverUrl}/api/`)) {
    throw new Error('网络歌曲缓存信息不完整，请刷新网络列表')
  }
  const connection = await fileHash(new TextEncoder().encode(JSON.stringify([serverUrl, token])))
  return {
    connection,
    folderId: audio.folderId,
    folderName: audio.folderName,
    audioId: audio.id,
    filename: audio.filename,
    hash: audio.hash!,
    lyricsHash: audio.hasLyrics ? (audio.lyricsHash ?? null) : null,
    hasLyrics: audio.hasLyrics
  }
}

export async function readNetworkCache(key: NetworkCacheKey) {
  try {
    const files = await invoke<CachedFiles | null>('plugin:network-cache|read_cache', { key })
    if (!files) return
    const [audioFile, lrc] = await Promise.all([
      readFile(files.audioPath),
      key.hasLyrics
        ? files.lyricsPath
          ? readTextFile(files.lyricsPath)
          : Promise.reject(new Error('缓存歌词缺失'))
        : Promise.resolve(undefined)
    ])
    return { audioFile, lrc }
  } catch {
    // Unreadable or incomplete caches fall back to the existing network download.
    return
  }
}

let pendingWrite: Promise<void> = Promise.resolve()

const CACHE_CHUNK_SIZE = 64 * 1024

async function sendCachePayload(payload: ArrayBuffer) {
  if (!isMobile) {
    await invoke<void>('plugin:network-cache|save_cache', payload)
    return
  }
  // Mobile WebViews can use JSON IPC for an ArrayBuffer request.
  // Bound each array conversion and yield to the WebView between native callbacks.
  const rid = await invoke<number>('plugin:network-cache|begin_cache_write', { size: payload.byteLength })
  let finished = false
  try {
    for (let offset = 0; offset < payload.byteLength; offset += CACHE_CHUNK_SIZE) {
      const data = new Uint8Array(payload, offset, Math.min(CACHE_CHUNK_SIZE, payload.byteLength - offset))
      await invoke<void>('plugin:network-cache|write_cache_chunk', { rid, offset, data })
    }
    await invoke<void>('plugin:network-cache|finish_cache_write', { rid })
    finished = true
  } finally {
    if (!finished) await invoke<void>('plugin:network-cache|abort_cache_write', { rid }).catch(() => {})
  }
}

export function saveNetworkCache(key: NetworkCacheKey, audio: Blob, lrc?: string) {
  // Keep replacements ordered even when an older song is still being saved.
  const write = pendingWrite.then(async () => {
    const metadata = new TextEncoder().encode(JSON.stringify({ key, lyrics: key.hasLyrics ? lrc : null }))
    const size = new ArrayBuffer(4)
    new DataView(size).setUint32(0, metadata.byteLength, true)
    // The mobile bridge writes bounded JSON chunks.
    const payload = await new Blob([size, metadata, audio]).arrayBuffer()
    await sendCachePayload(payload)
  })
  pendingWrite = write.catch(() => {})
  return write
}

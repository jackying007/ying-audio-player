import { invoke } from '@tauri-apps/api/core'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { fileHash } from './file-hash'
import { useNetworkSettings } from '@/store/network-settings'
import type { AudioInfo } from '@/store/audio-store'

export type NetworkCacheKey = {
  connection: string
  folderId: number
  folderName: string
  audioId: number
  filename: string
  version: string
  hasLyrics: boolean
}

type CachedFiles = { audioPath: string; lyricsPath?: string | null }

export async function networkCacheKey(audio: AudioInfo): Promise<NetworkCacheKey> {
  // Capture credentials before hashing; a configuration change must not relabel an old download.
  const { serverUrl, token } = useNetworkSettings.getState()
  if (!audio.filename || !audio.version || !audio.folderName || !audio.link.startsWith(`${serverUrl}/api/`)) {
    throw new Error('网络歌曲缓存信息不完整，请刷新网络列表')
  }
  const connection = await fileHash(new TextEncoder().encode(JSON.stringify([serverUrl, token])))
  return {
    connection,
    folderId: audio.folderId,
    folderName: audio.folderName,
    audioId: audio.id,
    filename: audio.filename,
    version: audio.version,
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

export function saveNetworkCache(key: NetworkCacheKey, audio: Blob, lrc?: string) {
  // Keep replacements ordered even when an older song is still being saved.
  const write = pendingWrite.then(async () => {
    const metadata = new TextEncoder().encode(JSON.stringify({ key, lyrics: key.hasLyrics ? lrc : null }))
    const size = new ArrayBuffer(4)
    new DataView(size).setUint32(0, metadata.byteLength, true)
    // Use Tauri's raw binary payload instead of expanding audio into a JSON number array.
    const payload = await new Blob([size, metadata, audio]).arrayBuffer()
    await invoke<void>('plugin:network-cache|save_cache', payload)
  })
  pendingWrite = write.catch(() => {})
  return write
}

import { invoke } from '@tauri-apps/api/core'
import { networkApi } from '@/api'
import { usesNativePlayback } from '@/lib/native-platform'
import type { AudioInfo } from '@/store/audio-store'
import { useNetworkSettings } from '@/store/network-settings'

type CoverSong = Pick<AudioInfo, 'id' | 'folderName' | 'filename'>

const maxBytes = 16 * 1024 * 1024

function newCache() {
  return { covers: new Map<string, Blob>(), loading: new Map<string, Promise<Blob>>(), bytes: 0 }
}

let currentCache = newCache()
useNetworkSettings.subscribe((settings, previous) => {
  if (settings.serverUrl !== previous.serverUrl || settings.token !== previous.token) currentCache = newCache()
})

async function load(audio: CoverSong, coverLink: string) {
  if (!usesNativePlayback) return networkApi.getCover(coverLink)
  const { serverUrl, token } = useNetworkSettings.getState()
  const bytes = await invoke<ArrayBuffer | number[]>('plugin:native-playback|load_cover', {
    audioId: audio.id,
    folderName: audio.folderName,
    filename: audio.filename,
    coverLink,
    serverUrl,
    token
  })
  return new Blob([new Uint8Array(bytes)])
}

export function getNetworkCover(audio: CoverSong, coverLink: string) {
  const cache = currentCache
  const key = usesNativePlayback ? JSON.stringify([coverLink, audio.folderName, audio.filename]) : coverLink
  const existing = cache.covers.get(key)
  if (existing) {
    cache.covers.delete(key)
    cache.covers.set(key, existing)
    return Promise.resolve(existing)
  }

  const loading = cache.loading.get(key)
  if (loading) return loading

  const request = load(audio, coverLink)
    .then(cover => {
      if (cover.size === 0) throw new Error('歌曲封面为空')
      if (cover.size <= maxBytes) {
        for (const [oldKey, old] of cache.covers) {
          if (cache.bytes + cover.size <= maxBytes) break
          cache.covers.delete(oldKey)
          cache.bytes -= old.size
        }
        cache.covers.set(key, cover)
        cache.bytes += cover.size
      }
      return cover
    })
    .finally(() => cache.loading.delete(key))
  cache.loading.set(key, request)
  return request
}

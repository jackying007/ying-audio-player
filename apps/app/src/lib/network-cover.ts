import { invoke } from '@tauri-apps/api/core'
import { networkApi } from '@/api'
import { usesNativePlayback } from '@/lib/native-platform'
import { useNetworkSettings } from '@/store/network-settings'

const maxBytes = 16 * 1024 * 1024

function newCache() {
  return { covers: new Map<string, Blob>(), loading: new Map<string, Promise<Blob>>(), bytes: 0 }
}

let currentCache = newCache()
useNetworkSettings.subscribe((settings, previous) => {
  if (settings.serverUrl !== previous.serverUrl || settings.token !== previous.token) currentCache = newCache()
})

async function load(audioId: number, coverLink: string) {
  if (!usesNativePlayback) return networkApi.getCover(coverLink)
  const { serverUrl, token } = useNetworkSettings.getState()
  const bytes = await invoke<ArrayBuffer | number[]>('plugin:native-playback|load_cover', {
    audioId,
    coverLink,
    serverUrl,
    token
  })
  return new Blob([new Uint8Array(bytes)])
}

export function getNetworkCover(audioId: number, coverLink: string) {
  const cache = currentCache
  const existing = cache.covers.get(coverLink)
  if (existing) {
    cache.covers.delete(coverLink)
    cache.covers.set(coverLink, existing)
    return Promise.resolve(existing)
  }

  const loading = cache.loading.get(coverLink)
  if (loading) return loading

  const request = load(audioId, coverLink)
    .then(cover => {
      if (cover.size === 0) throw new Error('歌曲封面为空')
      if (cover.size <= maxBytes) {
        for (const [key, old] of cache.covers) {
          if (cache.bytes + cover.size <= maxBytes) break
          cache.covers.delete(key)
          cache.bytes -= old.size
        }
        cache.covers.set(coverLink, cover)
        cache.bytes += cover.size
      }
      return cover
    })
    .finally(() => cache.loading.delete(coverLink))
  cache.loading.set(coverLink, request)
  return request
}

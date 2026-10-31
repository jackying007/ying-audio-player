import { useNetworkSettings } from '@/store/network-settings'
import type { AudioInfo } from '@/store/audio-store'
import type { NetworkAudio } from '@/api'

export function toNetworkAudio(row: NetworkAudio): AudioInfo {
  const base = `${useNetworkSettings.getState().serverUrl}/api/audios/${row.id}`
  return {
    ...row,
    source: 'network',
    scanError: null,
    hasCover: !!row.coverMime,
    coverLink: row.coverMime ? `${base}/cover?hash=${row.hash}` : undefined,
    link: `${base}/audio?hash=${row.hash}`,
    lrcLink: `${base}/lyrics?hash=${row.lyricsHash}`,
    type: 'audio/mpeg'
  }
}

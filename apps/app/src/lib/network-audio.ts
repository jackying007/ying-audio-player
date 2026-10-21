import { useNetworkSettings } from '@/store/network-settings'
import type { AudioInfo } from '@/store/audio-store'
import type { NetworkAudio } from '@/api'

export function toNetworkAudio(row: NetworkAudio): AudioInfo {
  const base = `${useNetworkSettings.getState().serverUrl}/api/audios/${row.id}`
  return {
    ...row,
    source: 'network',
    scanError: null,
    cover: null,
    coverLink: row.coverMime ? `${base}/cover?v=${row.version}` : undefined,
    link: `${base}/audio?v=${row.version}`,
    lrcLink: `${base}/lyrics?v=${row.version}`,
    type: 'audio/mpeg'
  }
}

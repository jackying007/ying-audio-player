import { create } from 'zustand'
import { usesNativePlayback } from '@/lib/native-platform'
import { playModes } from '@/lib/playback-queue'
import { useAppStore } from './app-store'
import { createDesktopPlayback } from './desktop-playback'
import { createNativePlayback } from './native-playback'

export enum ShowMode {
  Hide,
  Bottom,
  Fullscreen
}

export enum PlayState {
  None,
  Playing,
  Paused,
  Ended
}

export type AudioInfo = {
  source?: 'local' | 'network'
  filename?: string
  hash?: string
  lyricsHash?: string | null
  folderName?: string
  coverLink?: string
  id: number
  folderId: number
  name: string
  title: string | null
  artist: string | null
  durationMs: number | null
  fileSize: number | null
  hasCover: boolean
  hasLyrics: boolean
  scanError: string | null
  link: string
  lrcLink: string
  type: string
}

export type AudioStore = {
  showMode: ShowMode
  playState: PlayState
  isLoading: boolean
  currentAudioInfo?: AudioInfo
  currentLrc?: string
  duration?: number
  currentTime?: number
  audioList: AudioInfo[]
  playlistFolderId?: number
  error?: string
  warning?: string
}

export const useAudioStore = create<AudioStore>(() => ({
  showMode: ShowMode.Hide,
  playState: PlayState.None,
  isLoading: false,
  audioList: []
}))

export const usePlayerOpen = () => {
  const showMode = useAudioStore(state => state.showMode)
  return showMode !== ShowMode.Hide
}

export type PlaybackStore = {
  useAudioStore: typeof useAudioStore
  PlayState: typeof PlayState
  ShowMode: typeof ShowMode
}

export { cachedMap } from './desktop-playback'

const playbackStore: PlaybackStore = { useAudioStore, PlayState, ShowMode }
const nativePlayback = usesNativePlayback ? createNativePlayback(playbackStore) : undefined
const backend = nativePlayback ?? createDesktopPlayback(playbackStore)

export function initAudioPlayback() {
  backend.init()
}

export const {
  pauseAudio,
  replayAudio,
  togglePauseOrPlay,
  playPrevAudio,
  playNextAudio,
  setCurrentTime,
  setVolume,
  invalidateAudioCache,
  removeLocalFolderFromPlayback,
  removeNetworkFolderFromPlayback
} = backend

export const playAudio: ReturnType<typeof createDesktopPlayback>['playAudio'] = (audio, playlist) =>
  backend.playAudio(audio, playlist)

export function cyclePlayMode() {
  const { playMode } = useAppStore.getState()
  useAppStore.setState({ playMode: playModes[(playModes.indexOf(playMode) + 1) % playModes.length] })
}

export function updatePlaybackFolder(folderId: number, source: 'local' | 'network', audios: AudioInfo[]) {
  if (nativePlayback) {
    nativePlayback.updatePlaybackFolder(folderId, source, audios)
    return
  }
  const player = useAudioStore.getState()
  if (player.playlistFolderId === folderId && (player.currentAudioInfo?.source ?? 'local') === source) {
    const currentAudioInfo = audios.find(audio => audio.id === player.currentAudioInfo?.id) ?? player.currentAudioInfo
    useAudioStore.setState({ audioList: audios, currentAudioInfo })
  }
}

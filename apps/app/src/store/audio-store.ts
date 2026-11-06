import { create } from 'zustand'
import { localAudio } from '@/lib/local-audio'
import { useAppStore } from './app-store'
import { PlaybackQueue, playModes, type PlaybackAction } from '@/lib/playback-queue'
import { networkApi } from '@/api'
import { networkCacheKey, readNetworkCache, saveNetworkCache, type NetworkCacheKey } from '@/lib/network-cache'
import { useNetworkSettings } from './network-settings'

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

type AudioStore = {
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

const playbackQueue = new PlaybackQueue()

function resetPlaybackQueue() {
  const { audioList, currentAudioInfo } = useAudioStore.getState()
  playbackQueue.reset(
    audioList.map(item => item.link),
    currentAudioInfo?.link
  )
}

useAudioStore.subscribe((state, previous) => {
  if (
    state.playlistFolderId !== previous.playlistFolderId ||
    (state.audioList !== previous.audioList &&
      (state.audioList.length !== previous.audioList.length ||
        state.audioList.some((item, index) => item.link !== previous.audioList[index]?.link)))
  ) {
    resetPlaybackQueue()
  }
})

useAppStore.subscribe((state, previous) => {
  if (state.playMode !== previous.playMode) resetPlaybackQueue()
})

export function cyclePlayMode() {
  const { playMode } = useAppStore.getState()
  useAppStore.setState({ playMode: playModes[(playModes.indexOf(playMode) + 1) % playModes.length] })
}

export const usePlayerOpen = () => {
  const showMode = useAudioStore(state => state.showMode)
  return showMode !== ShowMode.Hide
}

const audio = new Audio()
const PLAYBACK_GESTURE_REQUIRED = '请点按播放按钮继续'
const needsPlaybackGesture = (error: unknown) => error instanceof DOMException && error.name === 'NotAllowedError'

type CachedData = {
  objectUrl: string
  blob: Blob
  lrc?: string
  lyricsIdentity?: string
  folderId: number
  source: 'local' | 'network'
  warning?: string
  cacheKey?: NetworkCacheKey
  saved?: boolean
  saving?: Promise<void>
}
export const cachedMap = new Map<string, CachedData>()

function saveInBackground(link: string, cached: CachedData) {
  if (!cached.cacheKey || cached.saved || cached.saving || (cached.cacheKey.hasLyrics && cached.lrc === undefined)) {
    return
  }
  cached.saving = saveNetworkCache(cached.cacheKey, cached.blob, cached.lrc)
    .then(() => {
      cached.saved = true
      cached.warning = undefined
    })
    .catch(error => {
      console.warn('网络歌曲缓存保存失败', error)
      cached.warning = '本地缓存保存失败，本次仍可播放'
    })
    .finally(() => {
      cached.saving = undefined
      // A completed save must not change a different song or a new connection.
      if (cachedMap.get(link) === cached && useAudioStore.getState().currentAudioInfo?.link === link) {
        useAudioStore.setState({ warning: cached.warning })
      }
    })
}
function clearCachedObjectUrl() {
  for (const [link, { objectUrl }] of cachedMap.entries()) {
    if (objectUrl !== audio.src) {
      cachedMap.delete(link)
      URL.revokeObjectURL(objectUrl)
    }
  }
}
setInterval(clearCachedObjectUrl, 1000 * 60 * 10)

export function invalidateAudioCache(folderId: number, source: 'local' | 'network' = 'local') {
  for (const [link, cached] of cachedMap) {
    if (cached.folderId !== folderId || cached.source !== source) continue
    cachedMap.delete(link)
    if (cached.objectUrl !== audio.src) URL.revokeObjectURL(cached.objectUrl)
  }
}

let playRequest = 0
let activeUrl: string | undefined
let playbackAbort: AbortController | undefined

function stopPlayback(audioList: AudioInfo[] = []) {
  ++playRequest
  playbackAbort?.abort()
  pauseAudio()
  audio.removeAttribute('src')
  audio.load()
  if (activeUrl) URL.revokeObjectURL(activeUrl)
  activeUrl = undefined
  useAudioStore.setState({
    currentAudioInfo: undefined,
    audioList,
    playlistFolderId: undefined,
    currentLrc: undefined,
    currentTime: 0,
    duration: undefined,
    showMode: ShowMode.Hide,
    playState: PlayState.None,
    isLoading: false,
    error: undefined,
    warning: undefined
  })
}

export function removeLocalFolderFromPlayback(folderId: number) {
  removeFolderFromPlayback(folderId, 'local')
}

export function removeNetworkFolderFromPlayback(folderId: number) {
  removeFolderFromPlayback(folderId, 'network')
}

function removeFolderFromPlayback(folderId: number, source: 'local' | 'network') {
  const player = useAudioStore.getState()
  const belongsToFolder = (item: AudioInfo) => (item.source ?? 'local') === source && item.folderId === folderId
  const audioList = player.audioList.filter(item => !belongsToFolder(item))
  if (player.currentAudioInfo && belongsToFolder(player.currentAudioInfo)) {
    stopPlayback(audioList)
  } else if (audioList.length !== player.audioList.length) {
    useAudioStore.setState({ audioList })
  }
  invalidateAudioCache(folderId, source)
}

useNetworkSettings.subscribe((state, previous) => {
  if (state.serverUrl === previous.serverUrl && state.token === previous.token) return
  if (useAudioStore.getState().currentAudioInfo?.source === 'network') {
    stopPlayback()
  }
  for (const [key, cached] of cachedMap) {
    if (cached.source !== 'network') continue
    URL.revokeObjectURL(cached.objectUrl)
    cachedMap.delete(key)
  }
})

export const pauseAudio = () => {
  if (!audio.paused) audio.pause()
}

async function readLrc(audioId: number) {
  try {
    return new TextDecoder().decode(await localAudio.readLyrics(audioId))
  } catch {
    return
  }
}
export const playAudio = async (
  audioInfo: AudioInfo,
  playlist?: Pick<AudioStore, 'audioList' | 'playlistFolderId'>
) => {
  const playback = startAudio(audioInfo, playlist)
  resetPlaybackQueue()
  return playback
}

const startAudio = async (audioInfo: AudioInfo, playlist?: Pick<AudioStore, 'audioList' | 'playlistFolderId'>) => {
  if (audioInfo.source !== 'network' && useAppStore.getState().removingFolderIds.includes(audioInfo.folderId)) {
    return false
  }
  const request = ++playRequest
  playbackAbort?.abort()
  const controller = new AbortController()
  playbackAbort = controller
  try {
    let cached = cachedMap.get(audioInfo.link)
    const remote = audioInfo.source === 'network'
    if (cached && remote && cached.lyricsIdentity !== audioInfo.lrcLink) {
      cached = {
        ...cached,
        lrc: undefined,
        lyricsIdentity: audioInfo.lrcLink,
        cacheKey: undefined,
        saved: false,
        saving: undefined,
        warning: '歌词已变化'
      }
      cachedMap.set(audioInfo.link, cached)
    }
    const retryNetworkCache = remote && !!cached?.warning
    if (!cached || retryNetworkCache) {
      pauseAudio()
      audio.removeAttribute('src')
      audio.load()
    }
    const reuseSource = cached?.objectUrl === audio.src && !audio.error
    const indexedDuration = audioInfo.durationMs == null ? undefined : audioInfo.durationMs / 1000
    useAudioStore.setState({
      ...playlist,
      showMode: ShowMode.Bottom,
      currentAudioInfo: audioInfo,
      currentLrc: cached?.lrc,
      currentTime: 0,
      duration: reuseSource && Number.isFinite(audio.duration) ? audio.duration : indexedDuration,
      playState: reuseSource && !audio.paused && !audio.ended ? PlayState.Playing : PlayState.None,
      isLoading: true,
      error: undefined,
      warning: undefined
    })
    if (cached && retryNetworkCache) {
      try {
        cached.cacheKey ??= await networkCacheKey(audioInfo)
        controller.signal.throwIfAborted()
        if (audioInfo.hasLyrics && cached.lrc === undefined) {
          cached.lrc = await networkApi.getLyrics(audioInfo.lrcLink, controller.signal)
        }
        if (request !== playRequest) return
        cached.warning = undefined
      } catch {
        cached.warning =
          audioInfo.hasLyrics && cached.lrc === undefined
            ? '歌词加载失败，请重试播放'
            : '本地缓存保存失败，本次仍可播放'
      }
    }
    if (!cached) {
      let warning: string | undefined
      const key = remote
        ? await networkCacheKey(audioInfo).catch(() => {
            warning = '本地缓存不可用，本次仍可播放'
            return undefined
          })
        : undefined
      controller.signal.throwIfAborted()
      const disk = key ? await readNetworkCache(key) : undefined
      controller.signal.throwIfAborted()
      const [audioFile, lrc] = disk
        ? ([disk.audioFile, disk.lrc] as const)
        : await Promise.all([
            remote
              ? networkApi.getAudio(audioInfo.link, controller.signal).then(bytes => new Uint8Array(bytes))
              : localAudio.readAudio(audioInfo.id),
            audioInfo.hasLyrics
              ? remote
                ? networkApi.getLyrics(audioInfo.lrcLink, controller.signal).catch(() => {
                    warning = '歌词加载失败，请重试播放'
                    return undefined
                  })
                : readLrc(audioInfo.id)
              : Promise.resolve(undefined)
          ])
      if (request !== playRequest) return
      const blob = new Blob([audioFile], { type: audioInfo.type })
      cached = {
        objectUrl: URL.createObjectURL(blob),
        blob,
        lrc,
        lyricsIdentity: audioInfo.lrcLink,
        folderId: audioInfo.folderId,
        source: remote ? 'network' : 'local',
        warning,
        cacheKey: key,
        saved: !!disk
      }
      cachedMap.set(audioInfo.link, cached)
    }
    if (request !== playRequest) return
    const previousUrl = activeUrl
    // Assigning src reloads the media resource, even when the Blob URL is unchanged.
    if (!reuseSource) audio.src = cached.objectUrl
    else if (audio.currentTime !== 0) audio.currentTime = 0
    activeUrl = cached.objectUrl
    if (previousUrl && previousUrl !== activeUrl && ![...cachedMap.values()].some(v => v.objectUrl === previousUrl)) {
      URL.revokeObjectURL(previousUrl)
    }
    audio.volume = useAppStore.getState().volume
    useAudioStore.setState({ currentLrc: cached.lrc, warning: cached.warning })
    await audio.play()
    if (request === playRequest) saveInBackground(audioInfo.link, cached)
    return request === playRequest
  } catch (error) {
    if (request !== playRequest) return false
    useAudioStore.setState({
      playState: PlayState.Paused,
      error:
        audio.src && needsPlaybackGesture(error)
          ? PLAYBACK_GESTURE_REQUIRED
          : `无法播放“${audioInfo.title ?? audioInfo.name}”：${String(error)}`
    })
    return false
  } finally {
    if (request === playRequest) useAudioStore.setState({ isLoading: false })
  }
}

export const replayAudio = async () => {
  const state = useAudioStore.getState()
  if (!state.currentAudioInfo) return
  if (
    (state.error && state.error !== PLAYBACK_GESTURE_REQUIRED) ||
    state.playState === PlayState.None ||
    audio.ended ||
    !audio.src
  ) {
    await startAudio(state.currentAudioInfo)
    return
  }
  const request = playRequest
  try {
    if (audio.paused) await audio.play()
    if (request !== playRequest) return
    useAudioStore.setState({ error: undefined })
    const cached = cachedMap.get(state.currentAudioInfo.link)
    if (cached && cached.objectUrl === activeUrl) saveInBackground(state.currentAudioInfo.link, cached)
  } catch (error) {
    if (request !== playRequest) return
    useAudioStore.setState({
      error: needsPlaybackGesture(error) ? PLAYBACK_GESTURE_REQUIRED : `无法继续播放：${String(error)}`,
      playState: PlayState.Paused
    })
  }
}

export const togglePauseOrPlay = () => {
  if (audio.paused || audio.ended) replayAudio()
  else pauseAudio()
}

export function playPrevAudio() {
  advanceAudio('previous')
}

export function playNextAudio() {
  advanceAudio('next')
}

function advanceAudio(action: PlaybackAction) {
  const { currentAudioInfo, audioList } = useAudioStore.getState()
  const link = playbackQueue.select(useAppStore.getState().playMode, action, currentAudioInfo?.link)
  const next =
    audioList.find(item => item.link === link) ?? (link === currentAudioInfo?.link ? currentAudioInfo : undefined)
  if (next) void startAudio(next)
}

export const setCurrentTime = (currentTime: number) => {
  if (Number.isFinite(currentTime) && audio.src) audio.currentTime = currentTime
}

export const setVolume = (volume: number) => {
  audio.volume = volume
}

audio.addEventListener('volumechange', () => {
  useAppStore.setState({
    volume: audio.volume
  })
})
audio.addEventListener('pause', () => {
  useAudioStore.setState({
    playState: PlayState.Paused
  })
})
audio.addEventListener('playing', () => {
  useAudioStore.setState({
    playState: PlayState.Playing
  })
})
audio.addEventListener('ended', () => {
  useAudioStore.setState({
    playState: PlayState.Ended
  })
  advanceAudio('ended')
})
audio.addEventListener('durationchange', () => {
  useAudioStore.setState({
    duration: Number.isFinite(audio.duration) ? audio.duration : undefined
  })
})

audio.addEventListener('error', () => {
  if (!audio.error) return
  useAudioStore.setState({
    playState: PlayState.Paused,
    isLoading: false,
    error: `音频播放失败：${audio.error.message || '文件不存在或格式不受支持'}`
  })
})
audio.addEventListener('timeupdate', () => {
  useAudioStore.setState({
    currentTime: audio.currentTime
  })
})

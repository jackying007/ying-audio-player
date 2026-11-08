import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AudioInfo, AudioStore, PlaybackStore } from './audio-store'
import { useAppStore } from './app-store'
import { useNetworkSettings } from './network-settings'
import type { PlayMode } from '@/lib/playback-queue'

type Playlist = Pick<AudioStore, 'audioList' | 'playlistFolderId'>
type Source = 'local' | 'network'
type Command =
  | { kind: 'play'; audio: AudioInfo; playlist?: Playlist }
  | { kind: 'updateFolder'; folderId: number; source: Source; audios: AudioInfo[] }
  | { kind: 'removeFolder'; folderId: number; source: Source }
  | { kind: 'connection'; serverUrl: string; token: string }
  | { kind: 'mode'; mode: PlayMode }
  | { kind: 'volume' | 'seek'; value: number }
  | { kind: 'pause' | 'resume' | 'toggle' | 'previous' | 'next' | 'stop' | 'snapshot' }

export type PlaybackSnapshot = {
  revision: number
  generation: number
  currentAudioInfo: AudioInfo | null
  audioList: AudioInfo[]
  playlistFolderId: number | null
  state: 'none' | 'playing' | 'paused' | 'ended'
  isLoading: boolean
  currentTime: number
  duration: number | null
  currentLrc: string | null
  error: string | null
  warning: string | null
}

export function createNativePlayback({ useAudioStore, PlayState, ShowMode }: PlaybackStore) {
  const playStates = {
    none: PlayState.None,
    playing: PlayState.Playing,
    paused: PlayState.Paused,
    ended: PlayState.Ended
  }
  let revision = -1
  let generation = -1
  let progressRevision = -1
  function applyPlaybackSnapshot(snapshot: PlaybackSnapshot) {
    if (snapshot.revision <= revision) return
    const newerProgress = snapshot.generation === generation && progressRevision > snapshot.revision
    revision = snapshot.revision
    generation = snapshot.generation
    const state = useAudioStore.getState()
    useAudioStore.setState({
      showMode: snapshot.currentAudioInfo ? state.showMode || ShowMode.Bottom : ShowMode.Hide,
      currentAudioInfo: snapshot.currentAudioInfo ?? undefined,
      audioList: snapshot.audioList,
      playlistFolderId: snapshot.playlistFolderId ?? undefined,
      playState: playStates[snapshot.state],
      isLoading: snapshot.isLoading,
      currentTime: newerProgress ? state.currentTime : snapshot.currentTime,
      duration: newerProgress ? state.duration : (snapshot.duration ?? undefined),
      currentLrc: snapshot.currentLrc ?? undefined,
      error: snapshot.error ?? undefined,
      warning: snapshot.warning ?? undefined
    })
  }

  type Progress = Pick<PlaybackSnapshot, 'revision' | 'generation' | 'currentTime' | 'duration'>
  function applyPlaybackProgress(progress: Progress) {
    if (progress.generation !== generation || progress.revision <= Math.max(revision, progressRevision)) return
    progressRevision = progress.revision
    useAudioStore.setState({ currentTime: progress.currentTime, duration: progress.duration ?? undefined })
  }

  let pending: Promise<unknown> = Promise.resolve()
  function send(command: Command) {
    const result = pending.then(async () => {
      const snapshot = await invoke<PlaybackSnapshot | null>('plugin:native-playback|control', { command })
      if (snapshot) applyPlaybackSnapshot(snapshot)
      return true
    })
    pending = result.catch(() => {
      useAudioStore.setState({ isLoading: false, error: '无法连接原生播放器，请重试' })
      return false
    })
    return pending as Promise<boolean>
  }

  function init() {
    void Promise.all([
      listen<PlaybackSnapshot>('native-playback-state', event => applyPlaybackSnapshot(event.payload)),
      listen<Progress>('native-playback-progress', event => applyPlaybackProgress(event.payload))
    ])
      .then(() => send({ kind: 'snapshot' }))
      .catch(() => {})

    const settings = useNetworkSettings.getState()
    const app = useAppStore.getState()
    void send({ kind: 'connection', serverUrl: settings.serverUrl, token: settings.token })
    void send({ kind: 'mode', mode: app.playMode })
    void send({ kind: 'volume', value: app.volume })
    useNetworkSettings.subscribe(({ serverUrl, token }, previous) => {
      if (serverUrl !== previous.serverUrl || token !== previous.token) {
        void send({ kind: 'connection', serverUrl, token })
      }
    })
    useAppStore.subscribe((state, previous) => {
      if (state.playMode !== previous.playMode) void send({ kind: 'mode', mode: state.playMode })
    })
    const refresh = () => {
      if (document.visibilityState === 'visible') void send({ kind: 'snapshot' })
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
  }

  async function playAudio(audio: AudioInfo, playlist?: Playlist) {
    if (audio.source !== 'network' && useAppStore.getState().removingFolderIds.includes(audio.folderId)) return
    return send({ kind: 'play', audio, playlist })
  }
  const pauseAudio = () => void send({ kind: 'pause' })
  const replayAudio = () => send({ kind: 'resume' })
  const togglePauseOrPlay = () => void send({ kind: 'toggle' })
  const playPrevAudio = () => void send({ kind: 'previous' })
  const playNextAudio = () => void send({ kind: 'next' })
  const setCurrentTime = (value: number) => {
    if (Number.isFinite(value)) void send({ kind: 'seek', value })
  }
  const setVolume = (value: number) => {
    if (!Number.isFinite(value)) return
    useAppStore.setState({ volume: value })
    void send({ kind: 'volume', value })
  }

  function updatePlaybackFolder(folderId: number, source: Source, audios: AudioInfo[]) {
    void send({ kind: 'updateFolder', folderId, source, audios })
  }

  function invalidateAudioCache(_folderId: number, _source?: Source) {
    // Native playback retains only the current file and checks disk markers on every new load.
  }
  const removeLocalFolderFromPlayback = (folderId: number) =>
    void send({ kind: 'removeFolder', source: 'local', folderId })
  const removeNetworkFolderFromPlayback = (folderId: number) =>
    void send({ kind: 'removeFolder', source: 'network', folderId })

  return {
    init,
    playAudio,
    pauseAudio,
    replayAudio,
    togglePauseOrPlay,
    playPrevAudio,
    playNextAudio,
    setCurrentTime,
    setVolume,
    invalidateAudioCache,
    removeLocalFolderFromPlayback,
    removeNetworkFolderFromPlayback,
    updatePlaybackFolder,
    applyPlaybackSnapshot,
    applyPlaybackProgress
  }
}

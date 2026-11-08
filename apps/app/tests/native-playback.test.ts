import { expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AudioInfo } from '../src/store/audio-store'
import type { PlaybackSnapshot } from '../src/store/native-playback'

test('foreground snapshot restores the native song, lyrics and progress without accepting stale updates', async () => {
  const { PlayState, ShowMode, useAudioStore: appAudioStore } = await import('../src/store/audio-store')
  const { createNativePlayback } = await import('../src/store/native-playback')
  const useAudioStore = create(() => appAudioStore.getInitialState())
  const { applyPlaybackProgress, applyPlaybackSnapshot } = createNativePlayback({ useAudioStore, PlayState, ShowMode })
  const song = { id: 12, name: 'Song', source: 'network', folderId: 4 } as AudioInfo
  const current: PlaybackSnapshot = {
    revision: 20,
    generation: 3,
    currentAudioInfo: song,
    audioList: [song],
    playlistFolderId: 4,
    state: 'playing',
    isLoading: false,
    currentTime: 13,
    duration: 200,
    currentLrc: '[00:13]Song',
    error: null,
    warning: null
  }
  applyPlaybackSnapshot(current)
  applyPlaybackProgress({ revision: 22, generation: 2, currentTime: 99, duration: 100 })
  applyPlaybackSnapshot({ ...current, revision: 19, state: 'paused', currentTime: 0 })

  expect(useAudioStore.getState()).toMatchObject({
    showMode: ShowMode.Bottom,
    playState: PlayState.Playing,
    currentAudioInfo: song,
    currentLrc: '[00:13]Song',
    currentTime: 13
  })

  applyPlaybackProgress({ revision: 25, generation: 3, currentTime: 17, duration: 200 })
  applyPlaybackProgress({ revision: 24, generation: 3, currentTime: 16, duration: 200 })
  applyPlaybackSnapshot({ ...current, revision: 23, state: 'paused', currentTime: 15 })
  expect(useAudioStore.getState()).toMatchObject({ playState: PlayState.Paused, currentTime: 17 })

  applyPlaybackSnapshot({ ...current, revision: 26, generation: 4, currentAudioInfo: null, state: 'none' })
  expect(useAudioStore.getState()).toMatchObject({ showMode: ShowMode.Hide, currentAudioInfo: undefined })
})

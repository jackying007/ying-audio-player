import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { open } from '@tauri-apps/plugin-dialog'
import { localAudio, type LocalAudioFolder } from '@/lib/local-audio'
import { isPlayMode, type PlayMode } from '@/lib/playback-queue'

type AppStore = {
  inited: boolean
  volume: number
  playMode: PlayMode
  localFolderList: LocalAudioFolder[]
  loading: boolean
  importing: boolean
  error?: string
  warnings: string[]
}

export const useAppStore = create<AppStore>()(
  persist(
    (): AppStore => ({
      inited: false,
      volume: 0.75,
      playMode: 'sequence',
      localFolderList: [],
      loading: false,
      importing: false,
      warnings: []
    }),
    {
      name: 'ying-audio-player-settings',
      partialize: state => ({ volume: state.volume, playMode: state.playMode }),
      merge: (persisted, current) => {
        const volume = (persisted as { volume?: unknown } | undefined)?.volume
        const playMode = (persisted as { playMode?: unknown } | undefined)?.playMode
        return {
          ...current,
          playMode: isPlayMode(playMode) ? playMode : current.playMode,
          volume:
            typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 1
              ? volume
              : current.volume
        }
      }
    }
  )
)

export async function initLocalAudio() {
  if (useAppStore.getState().loading) return
  useAppStore.setState({ loading: true, error: undefined })
  try {
    const localFolderList = await localAudio.listFolders()
    useAppStore.setState({ localFolderList, inited: true })
  } catch (error) {
    useAppStore.setState({ error: String(error), inited: true })
  } finally {
    useAppStore.setState({ loading: false })
  }
}

let lastImportPath: string | undefined
export async function importLocalFolder(retry = false) {
  if (useAppStore.getState().importing) return
  useAppStore.setState({ importing: true, error: undefined, warnings: [] })
  try {
    const path = retry && lastImportPath ? lastImportPath : await open({ multiple: false, directory: true })
    if (!path) return
    lastImportPath = path
    const result = await localAudio.importFolder(path)
    const localFolderList = await localAudio.listFolders()
    useAppStore.setState({ localFolderList, warnings: result.warnings })
    lastImportPath = undefined
    return result.folder.id
  } catch (error) {
    useAppStore.setState({ error: String(error) })
  } finally {
    useAppStore.setState({ importing: false })
  }
}

export function retryLocalAudio() {
  return lastImportPath ? importLocalFolder(true) : initLocalAudio()
}

void initLocalAudio()

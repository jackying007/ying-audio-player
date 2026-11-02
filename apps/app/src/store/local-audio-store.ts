import { create } from 'zustand'
import { localAudio } from '@/lib/local-audio'
import { useAppStore } from './app-store'
import {
  type AudioInfo,
  useAudioStore,
  playAudio,
  invalidateAudioCache,
  removeLocalFolderFromPlayback
} from './audio-store'
import { useNetworkAudioStore } from './network-audio-store'

type FolderAudio = {
  audios?: AudioInfo[]
  loading?: boolean
  refreshing?: boolean
  error?: string
  warnings?: string[]
}

export const useLocalAudioStore = create<Record<string, FolderAudio>>(() => ({}))
const generations = new Map<string, number>()

function update(folderId: string, patch: Partial<FolderAudio>) {
  useLocalAudioStore.setState(state => ({ [folderId]: { ...state[folderId], ...patch } }))
}

export async function loadFolderAudios(folderId: string) {
  if (useAppStore.getState().removingFolderIds.includes(Number(folderId))) return
  const id = Number(folderId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    update(folderId, { loading: false, error: '文件夹不存在，请从侧栏选择文件夹' })
    return
  }
  const generation = (generations.get(folderId) ?? 0) + 1
  generations.set(folderId, generation)
  update(folderId, { loading: true, error: undefined })
  try {
    const audios = await localAudio.listAudios(id)
    if (generations.get(folderId) !== generation) return
    update(folderId, { audios })
    const player = useAudioStore.getState()
    if (player.playlistFolderId === id && player.currentAudioInfo?.source !== 'network') {
      const currentAudioInfo = audios.find(audio => audio.id === player.currentAudioInfo?.id) ?? player.currentAudioInfo
      useAudioStore.setState({ audioList: audios, currentAudioInfo })
    }
  } catch (error) {
    if (generations.get(folderId) === generation) update(folderId, { error: String(error) })
  } finally {
    if (generations.get(folderId) === generation) update(folderId, { loading: false })
  }
}

export async function refreshFolder(folderId: string) {
  if (
    useLocalAudioStore.getState()[folderId]?.refreshing ||
    useAppStore.getState().removingFolderIds.includes(Number(folderId)) ||
    useNetworkAudioStore.getState().syncs[folderId]?.running
  )
    return
  update(folderId, { refreshing: true, error: undefined, warnings: [] })
  try {
    const result = await localAudio.refreshFolder(Number(folderId))
    invalidateAudioCache(Number(folderId))
    useAppStore.setState(state => ({
      localFolderList: state.localFolderList.map(folder => (folder.id === result.folder.id ? result.folder : folder))
    }))
    update(folderId, { warnings: result.warnings })
    await loadFolderAudios(folderId)
  } catch (error) {
    update(folderId, { error: String(error) })
  } finally {
    update(folderId, { refreshing: false })
  }
}

export const playLocalAudio = async (audioInfo: AudioInfo, folderId: string) => {
  const audioList = useLocalAudioStore.getState()[folderId]?.audios
  if (!audioList) return
  await playAudio(audioInfo, { audioList, playlistFolderId: Number(folderId) })
}

export async function removeLocalFolder(folderId: number): Promise<boolean> {
  const id = String(folderId)
  const app = useAppStore.getState()
  if (
    app.loading ||
    app.importing ||
    app.removingFolderIds.includes(folderId) ||
    !app.localFolderList.some(folder => folder.id === folderId) ||
    useLocalAudioStore.getState()[id]?.refreshing ||
    useNetworkAudioStore.getState().syncs[id]?.running
  )
    return false
  useAppStore.setState(state => ({ removingFolderIds: [...state.removingFolderIds, folderId] }))
  try {
    await localAudio.removeFolder(folderId)
    generations.set(id, (generations.get(id) ?? 0) + 1)
    useAppStore.setState(state => ({ localFolderList: state.localFolderList.filter(folder => folder.id !== folderId) }))
    useLocalAudioStore.setState(state => {
      const remaining = { ...state }
      delete remaining[id]
      return remaining
    }, true)
    useNetworkAudioStore.setState(state => {
      const syncs = { ...state.syncs }
      delete syncs[id]
      return { syncs }
    })
    removeLocalFolderFromPlayback(folderId)
    return true
  } finally {
    useAppStore.setState(state => ({ removingFolderIds: state.removingFolderIds.filter(value => value !== folderId) }))
  }
}

export async function playAllLocalAudios() {
  const { localFolderList } = useAppStore.getState()
  const folderAudios = await Promise.all(localFolderList.map(folder => localAudio.listAudios(folder.id)))
  const { localFolderList: currentFolders, removingFolderIds } = useAppStore.getState()
  const audioList = folderAudios
    .flat()
    .filter(
      audio =>
        currentFolders.some(folder => folder.id === audio.folderId) && !removingFolderIds.includes(audio.folderId)
    )
  const firstIndex = useAppStore.getState().playMode === 'shuffle' ? Math.floor(Math.random() * audioList.length) : 0
  const firstAudio = audioList[firstIndex]
  if (!firstAudio) throw new Error('暂无可播放的音乐')
  await playAudio(firstAudio, { audioList, playlistFolderId: undefined })
}

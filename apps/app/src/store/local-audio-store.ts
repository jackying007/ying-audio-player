import { create } from 'zustand'
import { localAudio } from '@/lib/local-audio'
import { useAppStore } from './app-store'
import { type AudioInfo, useAudioStore, playAudio, invalidateAudioCache } from './audio-store'

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
  if (useLocalAudioStore.getState()[folderId]?.refreshing) return
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

export async function playAllLocalAudios() {
  const { localFolderList } = useAppStore.getState()
  const folderAudios = await Promise.all(localFolderList.map(folder => localAudio.listAudios(folder.id)))
  const audioList = folderAudios.flat()
  const firstAudio = audioList[0]
  if (!firstAudio) throw new Error('暂无可播放的音乐')
  await playAudio(firstAudio, { audioList, playlistFolderId: undefined })
}

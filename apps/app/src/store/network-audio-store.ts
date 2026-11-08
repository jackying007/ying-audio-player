import { create } from 'zustand'
import { fileHash } from '@/lib/file-hash'
import { localAudio } from '@/lib/local-audio'
import { useNetworkSettings } from './network-settings'
import { useAppStore } from './app-store'
import { useLocalAudioStore } from './local-audio-store'
import {
  invalidateAudioCache,
  playAudio,
  removeNetworkFolderFromPlayback,
  updatePlaybackFolder,
  type AudioInfo
} from './audio-store'
import { connectionSignal, networkApi, HttpError, type NetworkFolder } from '@/api'
import { toNetworkAudio } from '@/lib/network-audio'

type Entry = { audios?: AudioInfo[]; loading: boolean; error?: string }
type SyncState = {
  running: boolean
  total: number
  completed: number
  succeeded: number
  skipped: number
  failures: string[]
  message?: string
}
type State = {
  folders: NetworkFolder[]
  loading: boolean
  error?: string
  entries: Record<string, Entry>
  syncs: Record<string, SyncState>
  removingFolders: NetworkFolder[]
}
export const useNetworkAudioStore = create<State>(() => ({
  folders: [],
  loading: false,
  entries: {},
  syncs: {},
  removingFolders: []
}))
let folderRequest = 0
const audioRequests = new Map<string, number>()
let audioRequestSequence = 0
const removedFolderIds = new Set<number>()

export async function loadNetworkFolders() {
  const request = ++folderRequest
  useNetworkAudioStore.setState({ loading: true, error: undefined })
  try {
    const folders = await networkApi.listFolders()
    if (request === folderRequest)
      useNetworkAudioStore.setState({ folders: folders.filter(folder => !removedFolderIds.has(folder.id)) })
  } catch (error) {
    if (request === folderRequest) useNetworkAudioStore.setState({ error: String(error) })
  } finally {
    if (request === folderRequest) useNetworkAudioStore.setState({ loading: false })
  }
}
function updateEntry(id: string, patch: Partial<Entry>) {
  useNetworkAudioStore.setState(state => ({
    entries: { ...state.entries, [id]: { ...state.entries[id], ...patch } as Entry }
  }))
}
export async function loadNetworkAudios(id: string) {
  if (
    removedFolderIds.has(Number(id)) ||
    useNetworkAudioStore.getState().removingFolders.some(folder => folder.id === Number(id))
  )
    return
  const request = ++audioRequestSequence
  audioRequests.set(id, request)
  updateEntry(id, { loading: true, error: undefined })
  try {
    const rows = await networkApi.listAudios(id)
    if (audioRequests.get(id) !== request) return
    let folderName = useNetworkAudioStore.getState().folders.find(folder => folder.id === Number(id))?.name
    if (!folderName) {
      await loadNetworkFolders()
      if (audioRequests.get(id) !== request) return
      folderName = useNetworkAudioStore.getState().folders.find(folder => folder.id === Number(id))?.name
    }
    const audios = rows.map(row => ({ ...toNetworkAudio(row), folderName }))
    updateEntry(id, { audios })
    updatePlaybackFolder(Number(id), 'network', audios)
  } catch (error) {
    if (audioRequests.get(id) === request) updateEntry(id, { error: String(error) })
  } finally {
    if (audioRequests.get(id) === request) updateEntry(id, { loading: false })
  }
}
export async function playNetworkAudio(audio: AudioInfo, folderId: string) {
  if (
    removedFolderIds.has(Number(folderId)) ||
    useNetworkAudioStore.getState().removingFolders.some(folder => folder.id === Number(folderId))
  )
    return
  const audios = useNetworkAudioStore.getState().entries[folderId]?.audios
  if (audios) await playAudio(audio, { audioList: audios, playlistFolderId: Number(folderId) })
}

export async function playAllNetworkAudios() {
  const signal = connectionSignal()
  const { folders } = useNetworkAudioStore.getState()
  try {
    const folderAudios = await Promise.all(
      folders.map(async folder => {
        const rows = await networkApi.listAudios(String(folder.id))
        return rows.map(row => ({ ...toNetworkAudio(row), folderName: folder.name }))
      })
    )
    if (signal.aborted) return
    const { folders: currentFolders, removingFolders } = useNetworkAudioStore.getState()
    const audioList = folderAudios
      .flat()
      .filter(
        audio =>
          currentFolders.some(folder => folder.id === audio.folderId) &&
          !removingFolders.some(folder => folder.id === audio.folderId)
      )
    const firstIndex = useAppStore.getState().playMode === 'shuffle' ? Math.floor(Math.random() * audioList.length) : 0
    const firstAudio = audioList[firstIndex]
    if (!firstAudio) throw new Error('暂无可播放的音乐')
    await playAudio(firstAudio, { audioList, playlistFolderId: undefined })
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

useNetworkSettings.subscribe((state, previous) => {
  if (state.serverUrl === previous.serverUrl && state.token === previous.token) return
  ++folderRequest
  audioRequests.clear()
  removedFolderIds.clear()
  useNetworkAudioStore.setState({ folders: [], loading: false, entries: {}, error: undefined, removingFolders: [] })
})

export async function removeNetworkFolder(folderId: number): Promise<boolean> {
  const state = useNetworkAudioStore.getState()
  const folder = state.folders.find(item => item.id === folderId)
  if (!folder || state.removingFolders.some(folder => folder.id === folderId)) return false
  if (
    useAppStore
      .getState()
      .localFolderList.some(local => local.name === folder.name && state.syncs[String(local.id)]?.running)
  )
    return false
  const signal = connectionSignal()
  useNetworkAudioStore.setState(state => ({ removingFolders: [...state.removingFolders, folder] }))
  try {
    await networkApi.deleteFolder(folderId)
    if (signal.aborted) return false
    removedFolderIds.add(folderId)
    ++folderRequest
    audioRequests.delete(String(folderId))
    useNetworkAudioStore.setState(state => {
      const entries = { ...state.entries }
      delete entries[String(folderId)]
      return { folders: state.folders.filter(folder => folder.id !== folderId), entries, loading: false }
    })
    removeNetworkFolderFromPlayback(folderId)
    return true
  } catch (error) {
    if (signal.aborted) return false
    throw error
  } finally {
    if (!signal.aborted)
      useNetworkAudioStore.setState(state => ({
        removingFolders: state.removingFolders.filter(folder => folder.id !== folderId)
      }))
  }
}

function updateSync(id: string, patch: Partial<SyncState>) {
  useNetworkAudioStore.setState(state => ({ syncs: { ...state.syncs, [id]: { ...state.syncs[id], ...patch } } }))
}
async function uploadFile(
  id: string,
  kind: 'audio' | 'lyrics' | 'cover',
  bytes: Uint8Array,
  limit: number,
  signal: AbortSignal
) {
  if (!bytes.byteLength || bytes.byteLength > limit) throw new Error(`${kind} 文件为空或超过大小限制`)
  await networkApi.uploadFile(id, kind, new Blob([new Uint8Array(bytes)]), signal)
}
export async function syncLocalFolder(id: string) {
  if (useAppStore.getState().removingFolderIds.includes(Number(id))) return
  const entry = useLocalAudioStore.getState()[id]
  if (!entry?.audios || entry.loading || entry.refreshing || useNetworkAudioStore.getState().syncs[id]?.running) return
  const folder = useAppStore.getState().localFolderList.find(item => item.id === Number(id))
  if (!folder) return
  if (useNetworkAudioStore.getState().removingFolders.some(remote => remote.name === folder.name)) return
  const signal = connectionSignal()
  const audios = [...entry.audios]
  const failures: string[] = []
  let succeeded = 0
  let skipped = 0
  updateSync(id, {
    running: true,
    total: audios.length,
    completed: 0,
    succeeded: 0,
    skipped: 0,
    failures: [],
    message: undefined
  })
  try {
    const remote = await networkApi.createFolder(folder.name, signal)
    for (const [index, audio] of audios.entries()) {
      if (signal.aborted) throw new Error('连接配置已变更，同步已停止')
      const filename = audio.filename ?? audio.name
      try {
        // Read before opening an upload, so missing local files leave no pending upload.
        if (!audio.filename) throw new Error('歌曲缺少原始文件名，请刷新文件夹后重试')
        const bytes = await localAudio.readAudio(audio.id)
        const lyrics = audio.hasLyrics ? await localAudio.readLyrics(audio.id) : undefined
        const localCover = audio.hasCover ? await localAudio.getCover(audio.id) : null
        if (audio.hasCover && !localCover) throw new Error('本地封面不存在，请刷新文件夹后重试')
        const cover = localCover ? new Uint8Array(localCover.data) : undefined
        const [hash, lyricsHash] = await Promise.all([fileHash(bytes), lyrics ? fileHash(lyrics) : null])
        signal.throwIfAborted()
        const upload = await networkApi.createUpload(
          remote.id,
          {
            filename,
            name: audio.name,
            title: audio.title,
            artist: audio.artist,
            durationMs: audio.durationMs,
            fileSize: audio.fileSize,
            hasLyrics: audio.hasLyrics,
            coverMime: localCover?.mime ?? null,
            hash,
            lyricsHash
          },
          signal
        )
        if (upload.unchanged) {
          skipped++
        } else {
          if (!upload.id) throw new Error('服务端未返回上传 ID')
          if (upload.requiredFiles.includes('audio'))
            await uploadFile(upload.id, 'audio', bytes, 50 * 1024 * 1024, signal)
          if (lyrics && upload.requiredFiles.includes('lyrics'))
            await uploadFile(upload.id, 'lyrics', lyrics, 1024 * 1024, signal)
          if (cover && upload.requiredFiles.includes('cover'))
            await uploadFile(upload.id, 'cover', cover, 10 * 1024 * 1024, signal)
          await networkApi.commitUpload(upload.id, signal)
          succeeded++
          invalidateAudioCache(remote.id, 'network')
        }
      } catch (error) {
        if (signal.aborted || (error instanceof HttpError && (error.status === 401 || error.status === 503)))
          throw error
        failures.push(`${filename}：${String(error)}`)
      }
      updateSync(id, { completed: index + 1, succeeded, skipped, failures: [...failures] })
    }
    await loadNetworkFolders()
    await loadNetworkAudios(String(remote.id))
    updateSync(id, { message: `同步完成：成功 ${succeeded} 首，跳过 ${skipped} 首，失败 ${failures.length} 首` })
  } catch (error) {
    updateSync(id, { message: String(error) })
  } finally {
    updateSync(id, { running: false, succeeded, skipped, failures: [...failures] })
  }
}

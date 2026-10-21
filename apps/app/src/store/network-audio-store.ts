import { create } from 'zustand'
import { readFile } from '@tauri-apps/plugin-fs'
import { fileHash } from '@/lib/file-hash'
import { localAudio } from '@/lib/local-audio'
import { useNetworkSettings } from './network-settings'
import { useAppStore } from './app-store'
import { useLocalAudioStore } from './local-audio-store'
import { invalidateAudioCache, playAudio, useAudioStore, type AudioInfo } from './audio-store'
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
}
export const useNetworkAudioStore = create<State>(() => ({ folders: [], loading: false, entries: {}, syncs: {} }))
let folderRequest = 0
const audioRequests = new Map<string, number>()
let audioRequestSequence = 0

export async function loadNetworkFolders() {
  const request = ++folderRequest
  useNetworkAudioStore.setState({ loading: true, error: undefined })
  try {
    const folders = await networkApi.listFolders()
    if (request === folderRequest) useNetworkAudioStore.setState({ folders })
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
    const player = useAudioStore.getState()
    if (player.playlistFolderId === Number(id) && player.currentAudioInfo?.source === 'network') {
      const currentAudioInfo = audios.find(audio => audio.id === player.currentAudioInfo?.id) ?? player.currentAudioInfo
      useAudioStore.setState({ audioList: audios, currentAudioInfo })
    }
  } catch (error) {
    if (audioRequests.get(id) === request) updateEntry(id, { error: String(error) })
  } finally {
    if (audioRequests.get(id) === request) updateEntry(id, { loading: false })
  }
}
export async function playNetworkAudio(audio: AudioInfo, folderId: string) {
  const audios = useNetworkAudioStore.getState().entries[folderId]?.audios
  if (audios) await playAudio(audio, { audioList: audios, playlistFolderId: Number(folderId) })
}
useNetworkSettings.subscribe((state, previous) => {
  if (state.serverUrl === previous.serverUrl && state.token === previous.token) return
  ++folderRequest
  audioRequests.clear()
  useNetworkAudioStore.setState({ folders: [], loading: false, entries: {}, error: undefined })
})

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
      const filename = audio.link.split(/[\\/]/).pop()!
      try {
        // Read before opening an upload, so missing local files leave no pending upload.
        const bytes = await readFile(audio.link)
        const lyrics = audio.hasLyrics ? await readFile(audio.lrcLink) : undefined
        const localCover = audio.hasCover ? await localAudio.getCover(audio.id) : null
        if (audio.hasCover && !localCover) throw new Error('本地封面不存在，请刷新文件夹后重试')
        const cover = localCover ? new Uint8Array(localCover.data) : undefined
        const [audioHash, lyricsHash, coverHash] = await Promise.all([
          fileHash(bytes),
          lyrics ? fileHash(lyrics) : null,
          cover ? fileHash(cover) : null
        ])
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
            hashes: { audio: audioHash, lyrics: lyricsHash, cover: coverHash }
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

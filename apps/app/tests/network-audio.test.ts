import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { NetworkCacheKey } from '../src/lib/network-cache'

class TestAudio {
  static instance: TestAudio
  src = ''
  paused = true
  ended = false
  volume = 1
  currentTime = 0
  duration = 100
  listeners = new Map<string, () => void>()
  constructor() {
    TestAudio.instance = this
  }
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback)
  }
  removeAttribute() {
    this.src = ''
  }
  load() {}
  pause() {
    this.paused = true
    this.listeners.get('pause')?.()
  }
  async play() {
    this.paused = false
    this.listeners.get('playing')?.()
  }
}
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  }
})
Object.defineProperty(globalThis, 'Audio', { configurable: true, value: TestAudio })
const files = new Map<string, Uint8Array>()
let localInvokeHook: ((command: string, input: unknown) => Promise<unknown>) | undefined
let localReadHook: (() => Promise<Uint8Array>) | undefined
const localMediaRequests: { command: string; audioId: number }[] = []
type DiskEntry = { audioPath: string; lyricsPath: string | null }
const diskEntries = new Map<string, DiskEntry>()
let diskWriteError = false
let diskWriteHook: (() => Promise<void>) | undefined
let diskReadHook: ((key: NetworkCacheKey) => Promise<DiskEntry | null>) | undefined
mock.module('@tauri-apps/plugin-fs', () => ({
  readFile: async (path: string) => {
    if (path === 'C:/music/song.mp3' && localReadHook) return localReadHook()
    const bytes = files.get(path)
    if (!bytes) throw new Error('missing file')
    return bytes
  },
  readTextFile: async (path: string) => {
    if (!path.startsWith('cache/')) return '[00:01]local lyric'
    const bytes = files.get(path)
    if (!bytes) throw new Error('missing lyrics')
    return new TextDecoder().decode(bytes)
  }
}))
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, input: { key: NetworkCacheKey } | ArrayBuffer) => {
    if (command === 'plugin:local-audio|read_audio' || command === 'plugin:local-audio|read_lyrics') {
      const { audioId } = input as unknown as { audioId: number }
      localMediaRequests.push({ command, audioId })
      const current = useAudioStore.getState().currentAudioInfo
      const indexed = Object.values(useLocalAudioStore.getState())
        .flatMap(entry => entry.audios ?? [])
        .find(audio => audio.id === audioId)
      const audio = current?.source !== 'network' && current?.id === audioId ? current : (indexed ?? local)
      if (command.endsWith('read_audio') && audioId === 1 && localReadHook)
        return (await localReadHook()).slice().buffer
      const bytes = files.get(command.endsWith('read_audio') ? audio.link : audio.lrcLink)
      if (!bytes) throw new Error('missing indexed file')
      return bytes.slice().buffer
    }
    if (command.startsWith('plugin:local-audio|') && localInvokeHook) return localInvokeHook(command, input)
    if (command === 'plugin:network-cache|read_cache') {
      const args = input as { key: NetworkCacheKey }
      return diskReadHook ? diskReadHook(args.key) : (diskEntries.get(JSON.stringify(args.key)) ?? null)
    }
    if (command === 'plugin:network-cache|save_cache') {
      expect(input).toBeInstanceOf(ArrayBuffer)
      const payload = input as ArrayBuffer
      const size = new DataView(payload).getUint32(0, true)
      const args = JSON.parse(new TextDecoder().decode(new Uint8Array(payload, 4, size))) as {
        key: NetworkCacheKey
        lyrics: string | null
      }
      await diskWriteHook?.()
      if (diskWriteError) throw new Error('disk full')
      const identity = JSON.stringify(args.key)
      for (const previous of diskEntries.keys()) {
        const key = JSON.parse(previous) as NetworkCacheKey
        if (key.folderName === args.key.folderName && key.filename === args.key.filename) {
          diskEntries.delete(previous)
        }
      }
      const audioPath = `cache/${identity}/song.mp3`
      const lyricsPath = args.key.hasLyrics ? `cache/${identity}/song.lrc` : null
      files.set(audioPath, new Uint8Array(payload, 4 + size))
      if (lyricsPath) files.set(lyricsPath, new TextEncoder().encode(args.lyrics!))
      diskEntries.set(identity, { audioPath, lyricsPath })
      return
    }
    return []
  }
}))
mock.module('@tauri-apps/plugin-dialog', () => ({ open: async () => null }))
const { useNetworkSettings, normalizeServerUrl } = await import('../src/store/network-settings')
const { networkApi, HttpError, connectionSignal } = await import('../src/api')
const { toNetworkAudio: convertNetworkAudio } = await import('../src/lib/network-audio')
const toNetworkAudio = (row: Parameters<typeof convertNetworkAudio>[0]) => ({
  ...convertNetworkAudio(row),
  folderName: '我的音乐'
})
const { playAudio, playNextAudio, cachedMap, invalidateAudioCache, useAudioStore, PlayState } =
  await import('../src/store/audio-store')
const {
  useNetworkAudioStore,
  loadNetworkFolders,
  loadNetworkAudios,
  syncLocalFolder,
  removeNetworkFolder,
  playAllNetworkAudios
} = await import('../src/store/network-audio-store')
const { useLocalAudioStore, removeLocalFolder, loadFolderAudios, refreshFolder, playAllLocalAudios } =
  await import('../src/store/local-audio-store')
const { useAppStore } = await import('../src/store/app-store')
import type { AudioInfo } from '../src/store/audio-store'

async function playAndSave(...args: Parameters<typeof playAudio>) {
  const result = await playAudio(...args)
  await cachedMap.get(args[0].link)?.saving
  return result
}

afterEach(async () => {
  await Promise.all([...cachedMap.values()].map(cached => cached.saving))
})

const originalFetch = globalThis.fetch
let fetchHandler: (url: string, init: RequestInit) => Promise<Response>
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  fetchHandler(String(input), { ...init, method: init?.method?.toUpperCase() })) as typeof fetch
afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})
const row = {
  id: 1,
  folderId: 1,
  filename: 'song.mp3',
  name: 'song',
  title: 'Title',
  artist: 'Artist',
  durationMs: 1000,
  fileSize: 5,
  hasLyrics: false,
  coverMime: null,
  version: 'v1'
}
const local: AudioInfo = {
  ...row,
  link: 'C:/music/song.mp3',
  lrcLink: 'C:/music/song.lrc',
  type: 'audio/mpeg',
  scanError: null,
  hasCover: false
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function prepareLocalRemoval() {
  useAppStore.setState({
    localFolderList: [
      { id: 1, name: '音乐', link: 'C:/music', scannedAt: 0 },
      { id: 2, name: '其他', link: 'C:/other', scannedAt: 0 }
    ]
  })
  useLocalAudioStore.setState({ '1': { audios: [local] } }, true)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function syncState(running: boolean) {
  return { running, total: 0, completed: 0, succeeded: 0, skipped: 0, failures: [] }
}

beforeEach(() => {
  useAppStore.setState({
    playMode: 'sequence',
    removingFolderIds: [],
    importing: false,
    loading: false,
    localFolderList: []
  })
  localInvokeHook = undefined
  localReadHook = undefined
  localMediaRequests.length = 0
  useNetworkSettings.setState({ serverUrl: '', token: '' })
  useNetworkSettings.setState({ serverUrl: 'http://localhost:8787', token: 'secret' })
  cachedMap.clear()
  files.clear()
  diskEntries.clear()
  diskWriteError = false
  diskWriteHook = undefined
  diskReadHook = undefined
  files.set(local.link, new TextEncoder().encode('music'))
  useAudioStore.setState({ currentAudioInfo: undefined, audioList: [], playlistFolderId: undefined, error: undefined })
  useNetworkAudioStore.setState({ syncs: {}, folders: [{ id: 1, name: '我的音乐' }], entries: {} })
  fetchHandler = async () => new Response('music')
})

test('play all network songs replaces the queue in folder and song order and starts the first song', async () => {
  await playAudio(local, { audioList: [local], playlistFolderId: 1 })
  useNetworkAudioStore.setState({
    folders: [
      { id: 2, name: '第二个文件夹' },
      { id: 1, name: '我的音乐' }
    ]
  })
  // The later folder responds first; response timing must not change queue order.
  const firstFolder = deferred<Response>()
  const secondFolderLoaded = deferred<void>()
  const requests: string[] = []
  fetchHandler = async url => {
    requests.push(url)
    if (url.endsWith('/folders/2/audios')) return firstFolder.promise
    if (url.endsWith('/folders/1/audios')) {
      secondFolderLoaded.resolve()
      return json([row])
    }
    return new Response('music')
  }
  const playing = playAllNetworkAudios()
  await secondFolderLoaded.promise
  expect(useAudioStore.getState().currentAudioInfo).toBe(local)
  firstFolder.resolve(
    json([
      { ...row, id: 3, folderId: 2 },
      { ...row, id: 2, folderId: 2 }
    ])
  )
  await playing
  const player = useAudioStore.getState()
  expect(player.audioList.map(audio => audio.id)).toEqual([3, 2, 1])
  expect(player.audioList.map(audio => audio.folderName)).toEqual(['第二个文件夹', '第二个文件夹', '我的音乐'])
  expect(player.audioList.every(audio => audio.source === 'network')).toBe(true)
  expect(player.playlistFolderId).toBeUndefined()
  expect(player.currentAudioInfo).toBe(player.audioList[0])
  expect(player.playState).toBe(PlayState.Playing)
  expect(requests.filter(url => url.includes('/api/audios/'))).toEqual([
    'http://localhost:8787/api/audios/3/audio?v=v1'
  ])
  playNextAudio()
  expect(useAudioStore.getState().currentAudioInfo?.id).toBe(2)
})

test.each([false, true])(
  'play all network songs preserves playback for an empty list (no folders: %s)',
  async noFolders => {
    await playAudio(local, { audioList: [local], playlistFolderId: 1 })
    const before = useAudioStore.getState()
    if (noFolders) useNetworkAudioStore.setState({ folders: [] })
    fetchHandler = async () => json([])
    await expect(playAllNetworkAudios()).rejects.toThrow('暂无可播放的音乐')
    expect(useAudioStore.getState()).toBe(before)
  }
)

test('play all network songs preserves playback when any folder request fails', async () => {
  await playAudio(local, { audioList: [local], playlistFolderId: 1 })
  const before = useAudioStore.getState()
  useNetworkAudioStore.setState({
    folders: [
      { id: 1, name: '我的音乐' },
      { id: 2, name: '其他' }
    ]
  })
  fetchHandler = async url =>
    url.endsWith('/folders/1/audios') ? json([row]) : new Response('加载歌曲失败', { status: 500 })
  await expect(playAllNetworkAudios()).rejects.toThrow('加载歌曲失败')
  expect(useAudioStore.getState()).toBe(before)
})

test.each([200, 401])('play all network songs discards old connection results (status: %s)', async status => {
  await playAudio(local, { audioList: [local], playlistFolderId: 1 })
  const before = useAudioStore.getState()
  const response = deferred<Response>()
  const requested = deferred<void>()
  fetchHandler = async () => {
    requested.resolve()
    return response.promise
  }
  const playing = playAllNetworkAudios()
  await requested.promise
  useNetworkSettings.setState({ token: 'new-secret' })
  response.resolve(status === 200 ? json([row]) : new Response('旧连接已取消', { status }))
  await playing
  expect(useAudioStore.getState()).toBe(before)
})

test.each(['removed', 'removing'])('play all network songs excludes a folder %s during loading', async state => {
  useNetworkAudioStore.setState({
    folders: [
      { id: 1, name: '我的音乐' },
      { id: 2, name: '其他' }
    ]
  })
  const response = deferred<Response>()
  const requested = deferred<void>()
  fetchHandler = async url => {
    if (url.endsWith('/folders/1/audios')) {
      requested.resolve()
      return response.promise
    }
    if (url.endsWith('/folders/2/audios')) return json([{ ...row, id: 2, folderId: 2 }])
    return new Response('music')
  }
  const playing = playAllNetworkAudios()
  await requested.promise
  if (state === 'removed') useNetworkAudioStore.setState({ folders: [{ id: 2, name: '其他' }] })
  else useNetworkAudioStore.setState({ removingFolders: [{ id: 1, name: '我的音乐' }] })
  response.resolve(json([row]))
  await playing
  expect(useAudioStore.getState().audioList.map(audio => audio.id)).toEqual([2])
  expect(useAudioStore.getState().currentAudioInfo?.id).toBe(2)
})

test('removing a local folder clears its index state, queue and cache, preserving other folders', async () => {
  prepareLocalRemoval()
  files.set('C:/other/other.mp3', new Uint8Array([1]))
  const other = { ...local, id: 2, folderId: 2, link: 'C:/other/other.mp3' }
  await playAudio(local, { audioList: [local, other], playlistFolderId: undefined })
  localInvokeHook = async (command, args) => {
    expect(command).toBe('plugin:local-audio|remove_folder')
    expect(args).toEqual({ folderId: 1 })
  }
  expect(await removeLocalFolder(1)).toBe(true)
  expect(useAppStore.getState().localFolderList.map(folder => folder.id)).toEqual([2])
  expect(useLocalAudioStore.getState()['1']).toBeUndefined()
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(useAudioStore.getState().audioList).toEqual([other])
  expect(TestAudio.instance.paused).toBe(true)
  expect(TestAudio.instance.src).toBe('')
  expect(cachedMap.has(local.link)).toBe(false)
})

test('deleting a network folder clears its list, playback and memory cache but preserves disk and local files', async () => {
  const remote = toNetworkAudio(row)
  await playAndSave(remote, { audioList: [remote, local], playlistFolderId: 1 })
  const diskBefore = [...diskEntries.entries()]
  const objectUrl = cachedMap.get(remote.link)!.objectUrl
  const revoke = spyOn(URL, 'revokeObjectURL')
  useNetworkAudioStore.setState({ entries: { '1': { audios: [remote], loading: false } } })
  fetchHandler = async (url, init) => {
    expect(url).toBe('http://localhost:8787/api/folders/1')
    expect(init.method).toBe('DELETE')
    return json({ ok: true })
  }
  expect(await removeNetworkFolder(1)).toBe(true)
  expect(useNetworkAudioStore.getState().folders).toEqual([])
  expect(useNetworkAudioStore.getState().entries['1']).toBeUndefined()
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(useAudioStore.getState().audioList).toEqual([local])
  expect(TestAudio.instance.src).toBe('')
  expect(cachedMap.has(remote.link)).toBe(false)
  expect(revoke).toHaveBeenCalledWith(objectUrl)
  revoke.mockRestore()
  expect([...diskEntries.entries()]).toEqual(diskBefore)
  expect(files.has(local.link)).toBe(true)
})

test('failed network deletion preserves playback and lists and permits a retry', async () => {
  const remote = toNetworkAudio(row)
  await playAndSave(remote, { audioList: [remote], playlistFolderId: 1 })
  useNetworkAudioStore.setState({ entries: { '1': { audios: [remote], loading: false } } })
  const before = useAudioStore.getState()
  fetchHandler = async () => new Response('密钥错误', { status: 401 })
  await expect(removeNetworkFolder(1)).rejects.toMatchObject({ status: 401, message: '密钥错误' })
  expect(useNetworkAudioStore.getState().folders).toHaveLength(1)
  expect(useNetworkAudioStore.getState().entries['1'].audios).toEqual([remote])
  expect(useNetworkAudioStore.getState().removingFolders).toEqual([])
  expect(useAudioStore.getState()).toBe(before)
  expect(cachedMap.has(remote.link)).toBe(true)
  fetchHandler = async () => json({ ok: true })
  expect(await removeNetworkFolder(1)).toBe(true)
})

test('network deletion and syncing local folders with the same name exclude each other', async () => {
  prepareLocalRemoval()
  useNetworkAudioStore.setState({ folders: [{ id: 7, name: '音乐' }], syncs: { '1': syncState(true) } })
  let calls = 0
  const ready = deferred<void>()
  const pending = deferred<Response>()
  fetchHandler = async (_url, init) => {
    expect(init.method).toBe('DELETE')
    calls++
    ready.resolve()
    return pending.promise
  }
  expect(await removeNetworkFolder(7)).toBe(false)
  expect(calls).toBe(0)
  useNetworkAudioStore.setState({ syncs: {} })
  const deleting = removeNetworkFolder(7)
  await ready.promise
  expect(useNetworkAudioStore.getState().removingFolders).toEqual([{ id: 7, name: '音乐' }])
  expect(await removeNetworkFolder(7)).toBe(false)
  await syncLocalFolder('1')
  expect(calls).toBe(1)
  expect(useNetworkAudioStore.getState().syncs['1']).toBeUndefined()
  pending.resolve(json({ ok: true }))
  expect(await deleting).toBe(true)
  expect(useNetworkAudioStore.getState().removingFolders).toEqual([])
})

test('deleting a network folder invalidates pending folder and song list responses', async () => {
  const foldersReady = deferred<void>()
  const audiosReady = deferred<void>()
  const foldersPending = deferred<Response>()
  const audiosPending = deferred<Response>()
  fetchHandler = async (url, init) => {
    if (init.method === 'DELETE') return json({ ok: true })
    if (url.endsWith('/folders')) {
      foldersReady.resolve()
      return foldersPending.promise
    }
    audiosReady.resolve()
    return audiosPending.promise
  }
  const loadingFolders = loadNetworkFolders()
  const loadingAudios = loadNetworkAudios('1')
  await Promise.all([foldersReady.promise, audiosReady.promise])
  expect(await removeNetworkFolder(1)).toBe(true)
  foldersPending.resolve(json([{ id: 1, name: '我的音乐' }]))
  audiosPending.resolve(json([row]))
  await Promise.all([loadingFolders, loadingAudios])
  expect(useNetworkAudioStore.getState()).toMatchObject({ folders: [], entries: {}, loading: false })
  fetchHandler = async () => json([{ id: 1, name: '我的音乐' }])
  await loadNetworkFolders()
  await loadNetworkAudios('1')
  expect(useNetworkAudioStore.getState().folders).toEqual([])
  expect(useNetworkAudioStore.getState().entries).toEqual({})
})

test('a folder refresh cannot release a pending deletion lock on the same local folder name', async () => {
  prepareLocalRemoval()
  useNetworkAudioStore.setState({ folders: [{ id: 7, name: '音乐' }] })
  const ready = deferred<void>()
  const pending = deferred<Response>()
  fetchHandler = async (_url, init) => {
    if (init.method === 'DELETE') {
      ready.resolve()
      return pending.promise
    }
    expect(init.method).toBe('GET')
    return json([])
  }
  const deleting = removeNetworkFolder(7)
  await ready.promise
  await loadNetworkFolders()
  expect(useNetworkAudioStore.getState().folders).toEqual([])
  await syncLocalFolder('1')
  expect(useNetworkAudioStore.getState().syncs['1']).toBeUndefined()
  pending.resolve(json({ ok: true }))
  expect(await deleting).toBe(true)
})

test('switching connections prevents an old deletion response from changing new lists and playback', async () => {
  const ready = deferred<void>()
  const pending = deferred<Response>()
  let oldSignal: AbortSignal | null | undefined
  fetchHandler = async (_url, init) => {
    oldSignal = init.signal
    ready.resolve()
    return pending.promise
  }
  const deleting = removeNetworkFolder(1)
  await ready.promise
  useNetworkSettings.setState({ token: 'other' })
  const remote = toNetworkAudio(row)
  useNetworkAudioStore.setState({ folders: [{ id: 1, name: '新连接' }] })
  useAudioStore.setState({ currentAudioInfo: remote, audioList: [remote] })
  const state = useAudioStore.getState()
  pending.resolve(json({ ok: true }))
  expect(await deleting).toBe(false)
  expect(oldSignal?.aborted).toBe(true)
  expect(useNetworkAudioStore.getState().folders).toEqual([{ id: 1, name: '新连接' }])
  expect(useNetworkAudioStore.getState().removingFolders).toEqual([])
  expect(useAudioStore.getState()).toBe(state)
})

test('deleting a network folder stops an in-flight audio download and ignores its late response', async () => {
  const remote = toNetworkAudio(row)
  const ready = deferred<void>()
  const pending = deferred<Response>()
  let signal: AbortSignal | null | undefined
  fetchHandler = async (_url, init) => {
    if (init.method === 'DELETE') return json({ ok: true })
    signal = init.signal
    ready.resolve()
    return pending.promise
  }
  const playing = playAudio(remote, { audioList: [remote], playlistFolderId: 1 })
  await ready.promise
  expect(useAudioStore.getState().isLoading).toBe(true)
  await removeNetworkFolder(1)
  expect(useAudioStore.getState().isLoading).toBe(false)
  expect(signal?.aborted).toBe(true)
  pending.resolve(new Response('music'))
  await playing
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(useAudioStore.getState().audioList).toEqual([])
  expect(TestAudio.instance.src).toBe('')
  expect(cachedMap.has(remote.link)).toBe(false)
})

test('deleting a network folder cancels a disk lookup without downloading or restoring playback', async () => {
  const ready = deferred<void>()
  const pending = deferred<DiskEntry | null>()
  diskReadHook = async () => {
    ready.resolve()
    return pending.promise
  }
  fetchHandler = async (_url, init) => {
    expect(init.method).toBe('DELETE')
    return json({ ok: true })
  }
  const playing = playAudio(toNetworkAudio(row))
  await ready.promise
  await removeNetworkFolder(1)
  pending.resolve(null)
  expect(await playing).toBe(false)
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(cachedMap.size).toBe(0)
})

test('network deletion preserves local playback and another network folder with the same numeric IDs', async () => {
  const remote = toNetworkAudio(row)
  const other = toNetworkAudio({ ...row, id: 2, folderId: 2 })
  await playAndSave(remote)
  await playAndSave(other)
  await playAudio(local, { audioList: [local, remote, other], playlistFolderId: 1 })
  const src = TestAudio.instance.src
  fetchHandler = async () => json({ ok: true })
  await removeNetworkFolder(1)
  expect(useAudioStore.getState().currentAudioInfo).toBe(local)
  expect(useAudioStore.getState().audioList).toEqual([local, other])
  expect(TestAudio.instance.src).toBe(src)
  expect(TestAudio.instance.paused).toBe(false)
  expect(cachedMap.has(local.link)).toBe(true)
  expect(cachedMap.has(other.link)).toBe(true)
  expect(cachedMap.has(remote.link)).toBe(false)
})

test('a later explicit sync recreates a deleted network folder by name', async () => {
  prepareLocalRemoval()
  useNetworkAudioStore.setState({ folders: [{ id: 1, name: '音乐' }] })
  fetchHandler = async () => json({ ok: true })
  await removeNetworkFolder(1)
  fetchHandler = async (url, init) => {
    if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 3, name: '音乐' })
    if (url.endsWith('/folders')) return json([{ id: 3, name: '音乐' }])
    if (url.endsWith('/uploads')) return json({ id: null, unchanged: true, requiredFiles: [] })
    if (url.endsWith('/audios')) return json([{ ...row, folderId: 3 }])
    throw new Error(`Unexpected request: ${url}`)
  }
  await syncLocalFolder('1')
  expect(useNetworkAudioStore.getState().folders).toEqual([{ id: 3, name: '音乐' }])
  expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({ running: false, skipped: 1, failures: [] })
})

test('failed removal preserves the folder, queue and current playback and can be retried', async () => {
  prepareLocalRemoval()
  await playAudio(local, { audioList: [local], playlistFolderId: 1 })
  const before = useAudioStore.getState()
  localInvokeHook = async () => {
    throw new Error('database locked')
  }
  await expect(removeLocalFolder(1)).rejects.toThrow('database locked')
  expect(useAppStore.getState().localFolderList).toHaveLength(2)
  expect(useAppStore.getState().removingFolderIds).toEqual([])
  expect(useAudioStore.getState()).toBe(before)
  expect(useLocalAudioStore.getState()['1']?.audios).toEqual([local])
  localInvokeHook = async () => undefined
  expect(await removeLocalFolder(1)).toBe(true)
})

test('removal blocks duplicate removal, refresh, sync and new playback', async () => {
  prepareLocalRemoval()
  const pending = deferred<void>()
  let calls = 0
  localInvokeHook = async () => {
    calls++
    await pending.promise
  }
  const removing = removeLocalFolder(1)
  expect(await removeLocalFolder(1)).toBe(false)
  await refreshFolder('1')
  await syncLocalFolder('1')
  expect(await playAudio(local)).toBe(false)
  expect(calls).toBe(1)
  pending.resolve()
  await removing
})

test('import, refresh and sync prevent removal', async () => {
  prepareLocalRemoval()
  useAppStore.setState({ importing: true })
  expect(await removeLocalFolder(1)).toBe(false)
  useAppStore.setState({ importing: false })
  useLocalAudioStore.setState({ '1': { refreshing: true } })
  expect(await removeLocalFolder(1)).toBe(false)
  useLocalAudioStore.setState({ '1': { audios: [local] } })
  useNetworkAudioStore.setState({ syncs: { '1': syncState(true) } })
  expect(await removeLocalFolder(1)).toBe(false)
})

test('late folder listing and playback cannot restore a removed folder', async () => {
  prepareLocalRemoval()
  const listing = deferred<AudioInfo[]>()
  const reading = deferred<Uint8Array>()
  localInvokeHook = async command => (command.endsWith('list_audios') ? listing.promise : undefined)
  localReadHook = () => reading.promise
  const load = loadFolderAudios('1')
  const play = playAudio(local, { audioList: [local], playlistFolderId: 1 })
  await removeLocalFolder(1)
  listing.resolve([local])
  reading.resolve(new Uint8Array([1]))
  await Promise.all([load, play])
  expect(useLocalAudioStore.getState()['1']).toBeUndefined()
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(cachedMap.has(local.link)).toBe(false)
})

test('play all excludes folders removed while their lists are loading', async () => {
  prepareLocalRemoval()
  const listing = deferred<AudioInfo[]>()
  const other = { ...local, id: 2, folderId: 2, link: 'C:/other/other.mp3' }
  files.set(other.link, new Uint8Array([1]))
  localInvokeHook = async (command, args) => {
    if (command.endsWith('list_audios'))
      return (args as { folderId: number }).folderId === 1 ? listing.promise : [other]
  }
  const playing = playAllLocalAudios()
  await removeLocalFolder(1)
  listing.resolve([local])
  await playing
  expect(useAudioStore.getState().audioList).toEqual([other])
  expect(useAudioStore.getState().currentAudioInfo).toEqual(other)
})

test('removal preserves network playback with the same folder ID and clears only local sync results', async () => {
  prepareLocalRemoval()
  await playAudio(toNetworkAudio(row))
  const current = useAudioStore.getState().currentAudioInfo
  const src = TestAudio.instance.src
  useNetworkAudioStore.setState({ syncs: { '1': syncState(false), '2': syncState(false) } })
  await removeLocalFolder(1)
  expect(useAudioStore.getState().currentAudioInfo).toBe(current)
  expect(TestAudio.instance.src).toBe(src)
  expect(TestAudio.instance.paused).toBe(false)
  expect(useNetworkAudioStore.getState().syncs['1']).toBeUndefined()
  expect(useNetworkAudioStore.getState().syncs['2']).toBeDefined()
  expect(useNetworkAudioStore.getState().folders).toHaveLength(1)
})

test('settings normalize origins and reject credentials or API paths', () => {
  expect(normalizeServerUrl(' http://localhost:8787/ ')).toBe('http://localhost:8787')
  expect(() => normalizeServerUrl('https://user:password@example.com')).toThrow()
  expect(() => normalizeServerUrl('http://localhost:8787/api')).toThrow()
})

test('playback starts before a slow disk save finishes', async () => {
  let started!: () => void
  let release!: () => void
  const saving = new Promise<void>(resolve => {
    started = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  diskWriteHook = async () => {
    started()
    await blocked
  }
  let playbackResolved = false
  const playback = playAudio(toNetworkAudio(row)).then(() => {
    playbackResolved = true
  })
  await saving
  const stateWhileSaving = useAudioStore.getState().playState
  const loadingWhileSaving = useAudioStore.getState().isLoading
  const resolvedWhileSaving = playbackResolved
  release()
  await playback
  expect(stateWhileSaving).toBe(PlayState.Playing)
  expect(loadingWhileSaving).toBe(false)
  expect(resolvedWhileSaving).toBe(true)
})

test('a late background save failure does not alter the next song', async () => {
  let started!: () => void
  let release!: () => void
  const saving = new Promise<void>(resolve => {
    started = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  diskWriteHook = async () => {
    started()
    await blocked
    throw new Error('disk full')
  }
  const remote = toNetworkAudio(row)
  await playAudio(remote)
  await saving
  const pending = cachedMap.get(remote.link)!.saving
  await playAudio(local)
  release()
  await pending
  expect(useAudioStore.getState().currentAudioInfo?.link).toBe(local.link)
  expect(useAudioStore.getState().warning).toBeUndefined()
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
})

test('replaying while persistence is pending does not start a duplicate save', async () => {
  let started!: () => void
  let release!: () => void
  let writes = 0
  const saving = new Promise<void>(resolve => {
    started = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  diskWriteHook = async () => {
    writes++
    started()
    await blocked
  }
  const remote = toNetworkAudio(row)
  await playAudio(remote)
  await saving
  await playAudio(remote)
  release()
  await cachedMap.get(remote.link)?.saving
  expect(writes).toBe(1)
})
test.each(['local', 'network'] as const)(
  'loading covers %s reads until audio actually starts playing',
  async source => {
    const reading = deferred<Uint8Array>()
    const starting = deferred<void>()
    const ready = deferred<void>()
    localReadHook = () => reading.promise
    fetchHandler = async () => new Response((await reading.promise).slice().buffer)
    const originalPlay = TestAudio.instance.play.bind(TestAudio.instance)
    const play = spyOn(TestAudio.instance, 'play').mockImplementation(async () => {
      ready.resolve()
      await starting.promise
      await originalPlay()
    })
    try {
      const playing = playAudio(source === 'network' ? toNetworkAudio(row) : local)
      expect(useAudioStore.getState().isLoading).toBe(true)
      reading.resolve(new Uint8Array([1]))
      await ready.promise
      expect(useAudioStore.getState().isLoading).toBe(true)
      starting.resolve()
      await playing
      expect(useAudioStore.getState()).toMatchObject({ isLoading: false, playState: PlayState.Playing })
    } finally {
      starting.resolve()
      play.mockRestore()
    }
  }
)

test('failed downloads and playback clear loading', async () => {
  fetchHandler = async () => new Response('下载失败', { status: 500 })
  expect(await playAudio(toNetworkAudio(row))).toBe(false)
  expect(useAudioStore.getState()).toMatchObject({ isLoading: false, playState: PlayState.Paused })
  const play = spyOn(TestAudio.instance, 'play').mockRejectedValue(new Error('无法解码'))
  try {
    expect(await playAudio(local)).toBe(false)
    expect(useAudioStore.getState()).toMatchObject({ isLoading: false, playState: PlayState.Paused })
  } finally {
    play.mockRestore()
  }
})

test('an old read finishing cannot clear loading for a newer song', async () => {
  const reading = deferred<Uint8Array>()
  const downloading = deferred<Response>()
  localReadHook = () => reading.promise
  fetchHandler = async () => downloading.promise
  const first = playAudio(local)
  const remote = toNetworkAudio(row)
  const second = playAudio(remote)
  reading.resolve(new Uint8Array([1]))
  await first
  expect(useAudioStore.getState()).toMatchObject({ currentAudioInfo: remote, isLoading: true })
  downloading.resolve(new Response('music'))
  await second
  expect(useAudioStore.getState()).toMatchObject({ currentAudioInfo: remote, isLoading: false })
})

test('network playback downloads with auth and retains the metadata and playlist', async () => {
  const urls: string[] = []
  fetchHandler = async (url, init) => {
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret')
    urls.push(url)
    return new Response(url.includes('lyrics') ? '[00:01]cloud lyric' : 'music')
  }
  const audio = toNetworkAudio({ ...row, hasLyrics: true })
  await playAndSave(audio, { audioList: [audio], playlistFolderId: 1 })
  expect(urls).toHaveLength(2)
  expect(useAudioStore.getState()).toMatchObject({
    currentAudioInfo: { title: 'Title', source: 'network' },
    currentLrc: '[00:01]cloud lyric',
    playState: PlayState.Playing
  })
  expect(TestAudio.instance.src.startsWith('blob:')).toBe(true)
})
test('late download cannot replace a more recently selected song', async () => {
  let resolve!: (response: Response) => void
  let started!: () => void
  const downloading = new Promise<void>(done => {
    started = done
  })
  fetchHandler = async url =>
    url.includes('/1/')
      ? await new Promise<Response>(done => {
          resolve = done
          started()
        })
      : new Response('new song')
  const first = playAndSave(toNetworkAudio(row))
  await downloading
  const second = toNetworkAudio({ ...row, id: 2, name: 'second' })
  await playAndSave(second)
  const src = TestAudio.instance.src
  resolve(new Response('old song'))
  await first
  expect(useAudioStore.getState().currentAudioInfo?.name).toBe('second')
  expect(TestAudio.instance.src).toBe(src)
})
test('local and network cache invalidation are isolated and connection changes stop network playback', async () => {
  await playAndSave(local)
  const remote = toNetworkAudio(row)
  await playAndSave(remote)
  expect(cachedMap.size).toBe(2)
  invalidateAudioCache(1)
  expect(cachedMap.has(remote.link)).toBe(true)
  expect(cachedMap.has(local.link)).toBe(false)
  useNetworkSettings.setState({ token: 'changed' })
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(TestAudio.instance.src).toBe('')
  expect(cachedMap.size).toBe(0)
  await playAndSave(local)
  const src = TestAudio.instance.src
  useNetworkSettings.setState({ token: 'changed-again' })
  expect(TestAudio.instance.src).toBe(src)
  expect(useAudioStore.getState().currentAudioInfo?.link).toBe(local.link)
})
test('lyric failures warn without preventing audio playback', async () => {
  fetchHandler = async url =>
    url.includes('lyrics') ? new Response('missing', { status: 404 }) : new Response('music')
  await playAndSave(toNetworkAudio({ ...row, hasLyrics: true }))
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
  expect(useAudioStore.getState().warning).toContain('歌词加载失败')
  expect(diskEntries.size).toBe(0)
})

test('persisted audio and lyrics play without requests after the memory cache is cleared', async () => {
  const audio = { ...toNetworkAudio({ ...row, hasLyrics: true }), folderName: '我的音乐' }
  fetchHandler = async url => new Response(url.includes('lyrics') ? '[00:01]persisted lyric' : 'music')
  await playAndSave(audio)
  expect(diskEntries.size).toBe(1)
  const [identity] = diskEntries.keys()
  expect(JSON.parse(identity)).toMatchObject({ folderName: '我的音乐', filename: 'song.mp3', version: 'v1' })
  expect(identity).not.toContain('secret')
  cachedMap.clear()
  const requests: string[] = []
  fetchHandler = async url => {
    requests.push(url)
    throw new Error('offline')
  }
  expect(await playAndSave(audio)).toBe(true)
  expect(requests).toEqual([])
  expect(useAudioStore.getState().currentLrc).toBe('[00:01]persisted lyric')
  expect(useAudioStore.getState().warning).toBeUndefined()
})

test('songs without lyrics persist and play locally, while a new version downloads again', async () => {
  await playAndSave(toNetworkAudio(row))
  expect([...diskEntries.values()][0].lyricsPath).toBeNull()
  cachedMap.clear()
  let requests = 0
  fetchHandler = async () => {
    requests++
    return new Response('new music')
  }
  expect(await playAndSave(toNetworkAudio(row))).toBe(true)
  expect(requests).toBe(0)
  await playAndSave(toNetworkAudio({ ...row, version: 'v2' }))
  expect(requests).toBe(1)
})

test('missing disk audio or lyrics falls back to downloading and repairs the cache', async () => {
  const audio = toNetworkAudio({ ...row, hasLyrics: true })
  fetchHandler = async url => new Response(url.includes('lyrics') ? 'lyrics' : 'music')
  await playAndSave(audio)
  const entry = [...diskEntries.values()][0]
  for (const missing of [entry.audioPath, entry.lyricsPath!]) {
    cachedMap.clear()
    files.delete(missing)
    let requests = 0
    fetchHandler = async url => {
      requests++
      return new Response(url.includes('lyrics') ? 'lyrics' : 'music')
    }
    expect(await playAndSave(audio)).toBe(true)
    expect(requests).toBe(2)
    expect(files.has(missing)).toBe(true)
  }
})

test('disk read errors fall back to the network', async () => {
  diskReadHook = async () => {
    throw new Error('unreadable disk')
  }
  let requests = 0
  fetchHandler = async () => {
    requests++
    return new Response('music')
  }
  expect(await playAndSave(toNetworkAudio(row))).toBe(true)
  expect(requests).toBe(1)
})

test('disk write failures do not stop playback and retry from memory without downloading', async () => {
  diskWriteError = true
  const audio = toNetworkAudio(row)
  expect(await playAndSave(audio)).toBe(true)
  expect(useAudioStore.getState().warning).toContain('缓存保存失败')
  expect(diskEntries.size).toBe(0)
  diskWriteError = false
  const requests: string[] = []
  fetchHandler = async url => {
    requests.push(url)
    throw new Error('should not download')
  }
  expect(await playAndSave(audio)).toBe(true)
  expect(requests).toEqual([])
  expect(diskEntries.size).toBe(1)
  expect(useAudioStore.getState().warning).toBeUndefined()
})

test('retrying failed lyrics completes the persistent cache without downloading audio again', async () => {
  const audio = toNetworkAudio({ ...row, hasLyrics: true })
  fetchHandler = async url =>
    url.includes('lyrics') ? new Response('missing', { status: 404 }) : new Response('music')
  await playAndSave(audio)
  expect(diskEntries.size).toBe(0)
  const requests: string[] = []
  fetchHandler = async url => {
    requests.push(url)
    return new Response('recovered lyrics')
  }
  await playAndSave(audio)
  expect(requests).toEqual([audio.lrcLink])
  expect(useAudioStore.getState().currentLrc).toBe('recovered lyrics')
  expect(diskEntries.size).toBe(1)
})

test('changing credentials or the server never reuses a different connection at the same file path', async () => {
  await playAndSave(toNetworkAudio(row))
  let requests = 0
  fetchHandler = async () => {
    requests++
    return new Response('music')
  }
  useNetworkSettings.setState({ token: 'other' })
  await playAndSave(toNetworkAudio(row))
  useNetworkSettings.setState({ serverUrl: 'https://other.example' })
  await playAndSave(toNetworkAudio(row))
  expect(requests).toBe(2)
  useNetworkSettings.setState({ serverUrl: 'http://localhost:8787', token: 'secret' })
  await playAndSave(toNetworkAudio(row))
  expect(requests).toBe(3)
})

test('a connection change during a disk lookup cancels playback without downloading or saving', async () => {
  let resolve!: (entry: DiskEntry | null) => void
  let started!: () => void
  const reading = new Promise<void>(done => {
    started = done
  })
  diskReadHook = async () =>
    new Promise<DiskEntry | null>(done => {
      resolve = done
      started()
    })
  const requests: string[] = []
  fetchHandler = async url => {
    requests.push(url)
    return new Response('music')
  }
  const playback = playAndSave(toNetworkAudio(row))
  await reading
  useNetworkSettings.setState({ token: 'changed' })
  resolve(null)
  await playback
  expect(requests).toEqual([])
  expect(diskEntries.size).toBe(0)
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
})

test('network folder names are carried into the playback metadata', async () => {
  useNetworkAudioStore.setState({ folders: [{ id: 1, name: '我的音乐' }] })
  fetchHandler = async () => json([row])
  await loadNetworkAudios('1')
  expect(useNetworkAudioStore.getState().entries['1'].audios?.[0]).toMatchObject({
    folderName: '我的音乐',
    filename: 'song.mp3',
    version: 'v1'
  })
})

test('loading songs before the folder list resolves the real folder name before caching', async () => {
  useNetworkAudioStore.setState({ folders: [] })
  fetchHandler = async url => (url.endsWith('/folders') ? json([{ id: 1, name: '中文 歌单' }]) : json([row]))
  await loadNetworkAudios('1')
  const audio = useNetworkAudioStore.getState().entries['1'].audios![0]
  expect(audio.folderName).toBe('中文 歌单')
  fetchHandler = async () => new Response('music')
  await playAndSave(audio)
  expect(JSON.parse([...diskEntries.keys()][0]).folderName).toBe('中文 歌单')
})
test('old folder requests cannot overwrite a new connection', async () => {
  let resolve!: (response: Response) => void
  let started!: () => void
  const ready = new Promise<void>(done => {
    started = done
  })
  fetchHandler = async () =>
    await new Promise<Response>(done => {
      resolve = done
      started()
    })
  const old = loadNetworkAudios('1')
  await ready
  useNetworkSettings.setState({ token: 'new' })
  fetchHandler = async () => json([{ ...row, name: 'new connection' }])
  await loadNetworkAudios('1')
  resolve(json([{ ...row, name: 'old connection' }]))
  await old
  expect(useNetworkAudioStore.getState().entries['1'].audios?.[0].name).toBe('new connection')
})
test('replacing the current network song keeps repeat-one and next on the refreshed version', async () => {
  const rows = [row, { ...row, id: 2, name: 'second' }, { ...row, id: 3, name: 'third' }]
  const playlist = rows.map(toNetworkAudio)
  await playAndSave(playlist[1], { audioList: playlist, playlistFolderId: 1 })
  invalidateAudioCache(1, 'network')
  const downloads: string[] = []
  fetchHandler = async url => {
    if (url.includes('/folders/')) return json(rows.map(audio => ({ ...audio, version: 'v2' })))
    downloads.push(url)
    return new Response('new music')
  }
  await loadNetworkAudios('1')
  expect(useAudioStore.getState().currentAudioInfo?.link).toContain('/2/audio?v=v2')
  useAppStore.setState({ playMode: 'repeat-one' })
  TestAudio.instance.listeners.get('ended')?.()
  await waitForPlayback(() => downloads.length === 1)
  expect(downloads[0]).toContain('/2/audio?v=v2')
  useAppStore.setState({ playMode: 'sequence' })
  playNextAudio()
  await waitForPlayback(() => downloads.length === 2)
  expect(downloads[1]).toContain('/3/audio?v=v2')
})

async function waitForPlayback(downloaded: () => boolean) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (downloaded() && useAudioStore.getState().playState === PlayState.Playing) return
    await Bun.sleep(1)
  }
  throw new Error('Playback did not finish loading')
}
test('local lists and playback do not request or wait for covers', async () => {
  prepareLocalRemoval()
  const commands: string[] = []
  localInvokeHook = async (command, args) => {
    commands.push(command)
    expect(args).toEqual({ folderId: 1 })
    if (command.endsWith('list_audios')) return [{ ...local, hasCover: true }]
    throw new Error(`Unexpected command: ${command}`)
  }
  await loadFolderAudios('1')
  expect(useLocalAudioStore.getState()['1']).toMatchObject({ loading: false, audios: [{ hasCover: true }] })
  await playAudio(useLocalAudioStore.getState()['1'].audios![0], { audioList: [local], playlistFolderId: 1 })
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
  expect(commands).toEqual(['plugin:local-audio|list_audios'])
})

test('network audio exposes cover availability without embedding cover data', () => {
  const audio = toNetworkAudio({ ...row, coverMime: 'image/png' })
  expect(audio.hasCover).toBe(true)
  expect(audio.coverLink).toBe('http://localhost:8787/api/audios/1/cover?v=v1')
  expect(audio).not.toHaveProperty('cover')
  expect(toNetworkAudio(row).hasCover).toBe(false)
})

test('document URI playback and sync use indexed IDs and preserve the original filename and hashes', async () => {
  const song: AudioInfo = {
    ...local,
    id: 42,
    filename: '中文 原版.MP3',
    hasLyrics: true,
    link: 'content://provider/tree/opaque/document/unrelated%2F123',
    lrcLink: 'content://provider/tree/opaque/document/another%2F456'
  }
  const music = new Uint8Array([0, 255, 42])
  const lyrics = new TextEncoder().encode('[00:01]歌词')
  files.set(song.link, music)
  files.set(song.lrcLink, lyrics)
  useAppStore.setState({
    localFolderList: [{ id: 1, name: '音乐', link: 'content://provider/tree/opaque', scannedAt: 0 }]
  })
  useLocalAudioStore.setState({ '1': { audios: [song] } }, true)
  await playAudio(song)
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
  expect(useAudioStore.getState().currentLrc).toBe('[00:01]歌词')
  fetchHandler = async (url, init) => {
    if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 1, name: '音乐' })
    if (url.endsWith('/uploads')) {
      const data = JSON.parse(String(init.body))
      expect(data.filename).toBe('中文 原版.MP3')
      expect(data.hashes.audio).toBe(new Bun.CryptoHasher('sha256').update(music).digest('hex'))
      expect(data.hashes.lyrics).toBe(new Bun.CryptoHasher('sha256').update(lyrics).digest('hex'))
      expect(JSON.stringify(data)).not.toContain('content://')
      return json({ id: null, unchanged: true, requiredFiles: [] })
    }
    return json([])
  }
  await syncLocalFolder('1')
  expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({ skipped: 1, failures: [] })
  expect(localMediaRequests).toEqual([
    { command: 'plugin:local-audio|read_audio', audioId: 42 },
    { command: 'plugin:local-audio|read_lyrics', audioId: 42 },
    { command: 'plugin:local-audio|read_audio', audioId: 42 },
    { command: 'plugin:local-audio|read_lyrics', audioId: 42 }
  ])
})

test('an unreadable indexed local lyric does not prevent audio playback', async () => {
  await playAudio({ ...local, hasLyrics: true })
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
  expect(useAudioStore.getState().currentLrc).toBeUndefined()
})

test('sync uses current index, excludes local-only fields and continues after missing lyrics', async () => {
  useAppStore.setState({ localFolderList: [{ id: 1, name: 'music', link: 'C:/music', scannedAt: 0 }] })
  useLocalAudioStore.setState({
    '1': {
      audios: [
        { ...local, hasLyrics: true },
        { ...local, id: 2, scanError: 'warning' }
      ]
    }
  })
  let commits = 0
  fetchHandler = async (url, init) => {
    if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 1, name: 'music' })
    if (url.endsWith('/uploads')) {
      const data = JSON.parse(String(init.body))
      expect(data).toMatchObject({ filename: 'song.mp3', name: 'song', title: 'Title', artist: 'Artist' })
      expect(data).not.toHaveProperty('scanError')
      expect(data).not.toHaveProperty('link')
      expect(data).not.toHaveProperty('id')
      return json({ id: 'upload', unchanged: false, requiredFiles: ['audio'] })
    }
    if (url.endsWith('/commit')) {
      commits++
      return json({ ok: true })
    }
    if (url.endsWith('/folders')) return json([{ id: 1, name: 'music' }])
    if (url.endsWith('/audios')) return json([row])
    return json({ ok: true })
  }
  await syncLocalFolder('1')
  expect(commits).toBe(1)
  expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({ succeeded: 1, completed: 2, running: false })
  expect(useNetworkAudioStore.getState().syncs['1'].failures).toHaveLength(1)
})
test('sync skips unchanged songs and sends only files requested by the server', async () => {
  useAppStore.setState({ localFolderList: [{ id: 1, name: 'music', link: 'C:/music', scannedAt: 0 }] })
  useLocalAudioStore.setState({ '1': { audios: [local, { ...local, id: 2, name: 'second', hasLyrics: true }] } })
  files.set(local.lrcLink, new TextEncoder().encode('lyrics'))
  const writes: string[] = []
  let plans = 0
  fetchHandler = async (url, init) => {
    if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 1, name: 'music' })
    if (url.endsWith('/uploads')) {
      const body = JSON.parse(String(init.body))
      expect(body.hashes.audio).toBe(new Bun.CryptoHasher('sha256').update('music').digest('hex'))
      plans++
      return plans === 1
        ? json({ id: null, unchanged: true, requiredFiles: [] })
        : json({ id: 'lyrics-update', unchanged: false, requiredFiles: ['lyrics'] })
    }
    if (init.method === 'PUT' || url.endsWith('/commit')) {
      writes.push(url)
      return json({ ok: true })
    }
    if (url.endsWith('/folders')) return json([{ id: 1, name: 'music' }])
    if (url.endsWith('/audios')) return json([row])
    throw new Error(`Unexpected request: ${url}`)
  }
  await syncLocalFolder('1')
  expect(writes).toEqual([
    'http://localhost:8787/api/uploads/lyrics-update/lyrics',
    'http://localhost:8787/api/uploads/lyrics-update/commit'
  ])
  expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({
    succeeded: 1,
    skipped: 1,
    completed: 2,
    failures: []
  })
})

test('sync reads indexed covers separately, hashes them and uploads only when requested', async () => {
  prepareLocalRemoval()
  useLocalAudioStore.setState({
    '1': { audios: [1, 2, 3].map(id => ({ ...local, id, hasCover: true })) }
  })
  const coverData = new Uint8Array([0, 128, 255])
  const coverRequests: unknown[] = []
  localInvokeHook = async (command, args) => {
    expect(command).toBe('plugin:local-audio|get_cover')
    coverRequests.push(args)
    return { mime: 'image/png', data: [...coverData] }
  }
  let plans = 0
  const writes: string[] = []
  fetchHandler = async (url, init) => {
    if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 1, name: '音乐' })
    if (url.endsWith('/uploads')) {
      const data = JSON.parse(String(init.body))
      expect(data.coverMime).toBe('image/png')
      expect(data.hashes.cover).toBe(new Bun.CryptoHasher('sha256').update(coverData).digest('hex'))
      expect(data).not.toHaveProperty('hasCover')
      plans++
      return plans === 1
        ? json({ id: null, unchanged: true, requiredFiles: [] })
        : json({ id: `cover-${plans}`, unchanged: false, requiredFiles: plans === 2 ? [] : ['cover'] })
    }
    if (init.method === 'PUT') {
      writes.push(url)
      expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(coverData)
      return json({ ok: true })
    }
    if (url.endsWith('/commit')) return json({ ok: true })
    if (url.endsWith('/folders')) return json([{ id: 1, name: '音乐' }])
    if (url.endsWith('/audios')) return json([row])
    throw new Error(`Unexpected request: ${url}`)
  }
  await syncLocalFolder('1')
  expect(coverRequests).toEqual([{ audioId: 1 }, { audioId: 2 }, { audioId: 3 }])
  expect(writes).toEqual(['http://localhost:8787/api/uploads/cover-3/cover'])
  expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({ succeeded: 2, skipped: 1, failures: [] })
})

for (const failure of ['missing', 'error'] as const) {
  test(`sync fails a song when its indexed cover is ${failure}, then continues without clearing the remote cover`, async () => {
    prepareLocalRemoval()
    useLocalAudioStore.setState({
      '1': {
        audios: [
          { ...local, hasCover: true },
          { ...local, id: 2 }
        ]
      }
    })
    let coverRequests = 0
    localInvokeHook = async (command, args) => {
      expect(command).toBe('plugin:local-audio|get_cover')
      expect(args).toEqual({ audioId: 1 })
      coverRequests++
      if (failure === 'error') throw new Error('封面读取失败')
      return null
    }
    let uploads = 0
    fetchHandler = async (url, init) => {
      if (url.endsWith('/folders') && init.method === 'POST') return json({ id: 1, name: '音乐' })
      if (url.endsWith('/uploads')) {
        const data = JSON.parse(String(init.body))
        expect(data.coverMime).toBeNull()
        expect(data.hashes.cover).toBeNull()
        uploads++
        return json({ id: null, unchanged: true, requiredFiles: [] })
      }
      if (url.endsWith('/folders')) return json([{ id: 1, name: '音乐' }])
      if (url.endsWith('/audios')) return json([row])
      throw new Error(`Unexpected request: ${url}`)
    }
    await syncLocalFolder('1')
    expect(coverRequests).toBe(1)
    expect(uploads).toBe(1)
    expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({ completed: 2, succeeded: 0, skipped: 1 })
    expect(useNetworkAudioStore.getState().syncs['1'].failures).toHaveLength(1)
  })
}

test('API requests retain their connection snapshot while settings change', async () => {
  const requests: { url: string; token: string | null; signal?: AbortSignal | null }[] = []
  fetchHandler = async (url, init) => {
    requests.push({ url, token: new Headers(init.headers).get('Authorization'), signal: init.signal })
    return json([])
  }
  const oldSignal = connectionSignal()
  const old = networkApi.listFolders()
  useNetworkSettings.setState({ serverUrl: 'https://music.example', token: 'new-token' })
  await Promise.all([old, networkApi.listFolders()])
  expect(requests.map(({ url, token }) => ({ url, token }))).toEqual([
    { url: 'http://localhost:8787/api/folders', token: 'Bearer secret' },
    { url: 'https://music.example/api/folders', token: 'Bearer new-token' }
  ])
  expect(oldSignal.aborted).toBe(true)
  expect(requests[0].signal?.aborted).toBe(true)
  expect(requests[1].signal?.aborted).toBe(false)
})

test('API requests abort on caller cancellation and connection changes', async () => {
  for (const changeConnection of [false, true]) {
    let started!: () => void
    const ready = new Promise<void>(done => {
      started = done
    })
    fetchHandler = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        started()
      })
    const controller = new AbortController()
    const request = changeConnection
      ? networkApi.listFolders()
      : networkApi.getAudio('http://localhost:8787/api/audios/1/audio?v=v1', controller.signal)
    const result = request.catch(error => error)
    await ready
    if (changeConnection) useNetworkSettings.setState({ token: 'changed' })
    else controller.abort()
    expect(await result).toBeInstanceOf(DOMException)
  }
})

test('missing connection settings fail before sending a request', async () => {
  let calls = 0
  fetchHandler = async () => {
    calls++
    return json([])
  }
  for (const settings of [
    { serverUrl: '', token: 'secret' },
    { serverUrl: 'http://localhost:8787', token: '' }
  ]) {
    useNetworkSettings.setState(settings)
    await expect(networkApi.listFolders()).rejects.toMatchObject({
      status: 401,
      message: '请先在 App 设置中配置服务端地址和共享密钥'
    })
  }
  expect(calls).toBe(0)
})

test('API errors preserve status and text messages with a fallback for empty responses', async () => {
  fetchHandler = async () => new Response('密钥错误', { status: 401 })
  try {
    await networkApi.listFolders()
    throw new Error('Expected an HTTP error')
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401, message: '密钥错误' })
  }
  fetchHandler = async () => new Response('服务端未配置密钥', { status: 503 })
  await expect(networkApi.listFolders()).rejects.toMatchObject({ status: 503, message: '服务端未配置密钥' })
  fetchHandler = async () => new Response('', { status: 500 })
  await expect(networkApi.listFolders()).rejects.toMatchObject({ status: 500, message: '网络请求失败 (500)' })
})

test('media APIs preserve versions and return audio bytes, lyrics text and cover blobs', async () => {
  const urls: string[] = []
  fetchHandler = async (url, init) => {
    urls.push(url)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret')
    return new Response(url.includes('/lyrics') ? '[00:01]歌词' : new Uint8Array([0, 128, 255]), {
      headers: { 'Content-Type': url.includes('/cover') ? 'image/png' : 'application/octet-stream' }
    })
  }
  const base = 'http://localhost:8787/api/audios/1'
  expect(new Uint8Array(await networkApi.getAudio(base + '/audio?v=v1'))).toEqual(new Uint8Array([0, 128, 255]))
  expect(await networkApi.getLyrics(base + '/lyrics?v=v1')).toBe('[00:01]歌词')
  const cover = await networkApi.getCover(base + '/cover?v=v1')
  expect(cover.type).toBe('image/png')
  expect(new Uint8Array(await cover.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]))
  expect(urls).toEqual(['audio', 'lyrics', 'cover'].map(kind => base + '/' + kind + '?v=v1'))
})

test('media APIs reject stale server URLs without sending credentials', async () => {
  let calls = 0
  fetchHandler = async () => {
    calls++
    return new Response('music')
  }
  useNetworkSettings.setState({ serverUrl: 'https://music.example' })
  for (const request of [networkApi.getAudio, networkApi.getLyrics, networkApi.getCover]) {
    await expect(request('http://localhost:8787/api/audios/1/audio?v=v1')).rejects.toThrow('服务端地址已变更')
  }
  expect(calls).toBe(0)
})

test('upload APIs send JSON metadata and unmodified binary bodies', async () => {
  const bytes = new Uint8Array([0, 128, 255])
  fetchHandler = async (url, init) => {
    if (init.method === 'PUT') {
      expect(url).toBe('http://localhost:8787/api/uploads/upload/audio')
      expect(init.body).toBeInstanceOf(Blob)
      expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(bytes)
      expect(new Headers(init.headers).has('Content-Type')).toBe(false)
    } else {
      expect(new Headers(init.headers).get('Content-Type')).toContain('application/json')
      expect(JSON.parse(String(init.body))).toEqual({ name: '中文 歌单' })
    }
    return json({ ok: true })
  }
  await networkApi.createFolder('中文 歌单')
  await networkApi.uploadFile('upload', 'audio', new Blob([bytes]))
})

test('sync stops on authentication or service-unavailable errors', async () => {
  for (const status of [401, 503]) {
    useAppStore.setState({ localFolderList: [{ id: 1, name: 'music', link: 'C:/music', scannedAt: 0 }] })
    useLocalAudioStore.setState({ '1': { audios: [local, { ...local, id: 2 }] } })
    let uploads = 0
    fetchHandler = async url => {
      if (url.endsWith('/folders')) return json({ id: 1, name: 'music' })
      uploads++
      return new Response('停止同步', { status })
    }
    await syncLocalFolder('1')
    expect(uploads).toBe(1)
    expect(useNetworkAudioStore.getState().syncs['1']).toMatchObject({
      running: false,
      succeeded: 0,
      failures: [],
      message: 'HttpError: 停止同步'
    })
  }
})

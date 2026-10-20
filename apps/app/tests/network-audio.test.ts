import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
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
type DiskEntry = { audioPath: string; lyricsPath: string | null }
const diskEntries = new Map<string, DiskEntry>()
let diskWriteError = false
let diskWriteHook: (() => Promise<void>) | undefined
let diskReadHook: ((key: NetworkCacheKey) => Promise<DiskEntry | null>) | undefined
mock.module('@tauri-apps/plugin-fs', () => ({
  readFile: async (path: string) => {
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
const { toNetworkAudio: convertNetworkAudio } = await import('../src/lib/network-audio')
const toNetworkAudio = (row: Parameters<typeof convertNetworkAudio>[0]) => ({
  ...convertNetworkAudio(row),
  folderName: '我的音乐'
})
const { playAudio, playNextAudio, cachedMap, invalidateAudioCache, useAudioStore, PlayState } =
  await import('../src/store/audio-store')
const { useNetworkAudioStore, loadNetworkAudios, syncLocalFolder } = await import('../src/store/network-audio-store')
const { useLocalAudioStore } = await import('../src/store/local-audio-store')
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
  fetchHandler(String(input), init ?? {})) as typeof fetch
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
  cover: null
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  useAppStore.setState({ playMode: 'sequence' })
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
  const resolvedWhileSaving = playbackResolved
  release()
  await playback
  expect(stateWhileSaving).toBe(PlayState.Playing)
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
  fetchHandler = async url => (url.includes('lyrics') ? json({ message: 'missing' }, 404) : new Response('music'))
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
  fetchHandler = async url => (url.includes('lyrics') ? json({ message: 'missing' }, 404) : new Response('music'))
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
  fetchHandler = async () =>
    await new Promise<Response>(done => {
      resolve = done
    })
  const old = loadNetworkAudios('1')
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

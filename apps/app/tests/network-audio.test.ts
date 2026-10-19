import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

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
mock.module('@tauri-apps/plugin-fs', () => ({
  readFile: async (path: string) => {
    const bytes = files.get(path)
    if (!bytes) throw new Error('missing file')
    return bytes
  },
  readTextFile: async () => '[00:01]local lyric'
}))
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => [] }))
mock.module('@tauri-apps/plugin-dialog', () => ({ open: async () => null }))
const { useNetworkSettings, normalizeServerUrl } = await import('../src/store/network-settings')
const { toNetworkAudio } = await import('../src/lib/network-audio')
const { playAudio, playNextAudio, cachedMap, invalidateAudioCache, useAudioStore, PlayState } =
  await import('../src/store/audio-store')
const { useNetworkAudioStore, loadNetworkAudios, syncLocalFolder } = await import('../src/store/network-audio-store')
const { useLocalAudioStore } = await import('../src/store/local-audio-store')
const { useAppStore } = await import('../src/store/app-store')
import type { AudioInfo } from '../src/store/audio-store'

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
  files.set(local.link, new TextEncoder().encode('music'))
  useAudioStore.setState({ currentAudioInfo: undefined, audioList: [], playlistFolderId: undefined, error: undefined })
  useNetworkAudioStore.setState({ syncs: {} })
  fetchHandler = async () => new Response('music')
})

test('settings normalize origins and reject credentials or API paths', () => {
  expect(normalizeServerUrl(' http://localhost:8787/ ')).toBe('http://localhost:8787')
  expect(() => normalizeServerUrl('https://user:password@example.com')).toThrow()
  expect(() => normalizeServerUrl('http://localhost:8787/api')).toThrow()
})
test('network playback downloads with auth and retains the metadata and playlist', async () => {
  const urls: string[] = []
  fetchHandler = async (url, init) => {
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret')
    urls.push(url)
    return new Response(url.includes('lyrics') ? '[00:01]cloud lyric' : 'music')
  }
  const audio = toNetworkAudio({ ...row, hasLyrics: true })
  await playAudio(audio, { audioList: [audio], playlistFolderId: 1 })
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
  fetchHandler = async url =>
    url.includes('/1/')
      ? await new Promise<Response>(done => {
          resolve = done
        })
      : new Response('new song')
  const first = playAudio(toNetworkAudio(row))
  const second = toNetworkAudio({ ...row, id: 2, name: 'second' })
  await playAudio(second)
  const src = TestAudio.instance.src
  resolve(new Response('old song'))
  await first
  expect(useAudioStore.getState().currentAudioInfo?.name).toBe('second')
  expect(TestAudio.instance.src).toBe(src)
})
test('local and network cache invalidation are isolated and connection changes stop network playback', async () => {
  await playAudio(local)
  const remote = toNetworkAudio(row)
  await playAudio(remote)
  expect(cachedMap.size).toBe(2)
  invalidateAudioCache(1)
  expect(cachedMap.has(remote.link)).toBe(true)
  expect(cachedMap.has(local.link)).toBe(false)
  useNetworkSettings.setState({ token: 'changed' })
  expect(useAudioStore.getState().currentAudioInfo).toBeUndefined()
  expect(TestAudio.instance.src).toBe('')
  expect(cachedMap.size).toBe(0)
  await playAudio(local)
  const src = TestAudio.instance.src
  useNetworkSettings.setState({ token: 'changed-again' })
  expect(TestAudio.instance.src).toBe(src)
  expect(useAudioStore.getState().currentAudioInfo?.link).toBe(local.link)
})
test('lyric failures warn without preventing audio playback', async () => {
  fetchHandler = async url => (url.includes('lyrics') ? json({ message: 'missing' }, 404) : new Response('music'))
  await playAudio(toNetworkAudio({ ...row, hasLyrics: true }))
  expect(useAudioStore.getState().playState).toBe(PlayState.Playing)
  expect(useAudioStore.getState().warning).toContain('歌词加载失败')
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
  await playAudio(playlist[1], { audioList: playlist, playlistFolderId: 1 })
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
  await Bun.sleep(1)
  expect(downloads[0]).toContain('/2/audio?v=v2')
  useAppStore.setState({ playMode: 'sequence' })
  playNextAudio()
  await Bun.sleep(1)
  expect(downloads[1]).toContain('/3/audio?v=v2')
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

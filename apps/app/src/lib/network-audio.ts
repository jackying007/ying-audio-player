import { useNetworkSettings } from '@/store/network-settings'
import type { AudioInfo } from '@/store/audio-store'

export type NetworkFolder = { id: number; name: string }
export type UploadPlan = { id: string | null; unchanged: boolean; requiredFiles: ('audio' | 'lyrics' | 'cover')[] }
export type NetworkAudio = {
  id: number
  folderId: number
  filename: string
  name: string
  title: string | null
  artist: string | null
  durationMs: number | null
  fileSize: number | null
  hasLyrics: boolean
  coverMime: string | null
  version: string
}
export class NetworkError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

let connection = new AbortController()
export function connectionSignal() {
  return connection.signal
}
useNetworkSettings.subscribe((state, previous) => {
  if (state.serverUrl === previous.serverUrl && state.token === previous.token) return
  connection.abort()
  connection = new AbortController()
})

export async function audioRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const { serverUrl, token } = useNetworkSettings.getState()
  if (!serverUrl || !token) throw new NetworkError('请先在 App 设置中配置服务端地址和共享密钥', 401)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const signal = init.signal ? AbortSignal.any([connection.signal, init.signal]) : connection.signal
  const response = await fetch(`${serverUrl}/api${path}`, { ...init, headers, signal })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    throw new NetworkError(body?.message ?? `网络请求失败 (${response.status})`, response.status)
  }
  return response
}
export async function audioJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await audioRequest(path, init)).json()
}
export function postJson(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
}
export function toNetworkAudio(row: NetworkAudio): AudioInfo {
  const base = `${useNetworkSettings.getState().serverUrl}/api/audios/${row.id}`
  return {
    ...row,
    source: 'network',
    scanError: null,
    cover: null,
    coverLink: row.coverMime ? `${base}/cover?v=${row.version}` : undefined,
    link: `${base}/audio?v=${row.version}`,
    lrcLink: `${base}/lyrics?v=${row.version}`,
    type: 'audio/mpeg'
  }
}
export async function networkFile(url: string, signal?: AbortSignal) {
  const { serverUrl } = useNetworkSettings.getState()
  const prefix = `${serverUrl}/api`
  if (!url.startsWith(`${prefix}/`)) throw new Error('服务端地址已变更，请刷新网络列表')
  return audioRequest(url.slice(prefix.length), { signal })
}

import type { HttpRequest } from '@jying/http'
import { useNetworkSettings } from '@/store/network-settings'
import type { FileKind, NetworkAudio, NetworkFolder, UploadMetadata, UploadPlan } from '../types'

function mediaPath(url: string) {
  const prefix = `${useNetworkSettings.getState().serverUrl}/api`
  if (!url.startsWith(`${prefix}/`)) throw new Error('服务端地址已变更，请刷新网络列表')
  return url.slice(prefix.length)
}

export default function (http: HttpRequest) {
  return {
    listFolders() {
      return http.get<NetworkFolder[]>('/folders')
    },
    createFolder(name: string, signal?: AbortSignal) {
      return http.post<NetworkFolder>('/folders', { data: { name }, signal })
    },
    listAudios(id: string) {
      return http.get<NetworkAudio[]>(`/folders/${encodeURIComponent(id)}/audios`)
    },
    createUpload(folderId: number, data: UploadMetadata, signal?: AbortSignal) {
      return http.post<UploadPlan>(`/folders/${folderId}/uploads`, { data, signal })
    },
    putFile(id: string, kind: FileKind, body: Blob, signal?: AbortSignal) {
      return http.put<{ ok: boolean }>(`/uploads/${encodeURIComponent(id)}/${kind}`, { body, signal })
    },
    commitUpload(id: string, signal?: AbortSignal) {
      return http.post<{ ok: boolean }>(`/uploads/${encodeURIComponent(id)}/commit`, { signal })
    },
    async getAudio(url: string, signal?: AbortSignal) {
      return http.get(mediaPath(url), { responseType: 'arrayBuffer', signal })
    },
    async getLyrics(url: string, signal?: AbortSignal) {
      return http.get(mediaPath(url), { responseType: 'text', signal })
    },
    async getCover(url: string, signal?: AbortSignal) {
      return http.get(mediaPath(url), { responseType: 'blob', signal })
    }
  }
}

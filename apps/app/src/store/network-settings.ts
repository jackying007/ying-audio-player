import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useNetworkSettings = create(
  persist(() => ({ serverUrl: '', token: '' }), {
    name: 'ying-audio-player-network',
    partialize: state => ({ serverUrl: state.serverUrl, token: state.token })
  })
)

export function normalizeServerUrl(value: string) {
  if (!value.trim()) return ''
  const url = new URL(value.trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('请输入服务端根地址，例如 http://localhost:8787')
  }
  return url.origin
}

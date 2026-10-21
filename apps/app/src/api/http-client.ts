import { HttpRequest } from '@jying/http'
import { HttpError } from './http-error'
import { useNetworkSettings } from '@/store/network-settings'

export const http = new HttpRequest({
  logError: false
})

let connection = new AbortController()
export function connectionSignal() {
  return connection.signal
}
useNetworkSettings.subscribe((state, previous) => {
  if (state.serverUrl === previous.serverUrl && state.token === previous.token) return
  connection.abort()
  connection = new AbortController()
})

http.addHooks({
  beforeRequest: options => {
    const { serverUrl, token } = useNetworkSettings.getState()
    if (!serverUrl || !token)
      throw new HttpError('请先在 App 设置中配置服务端地址和共享密钥', {
        status: 401,
        statusText: 'Unauthorized'
      })
    return {
      ...options,
      url: `${serverUrl}/api${options.url}`,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: options.signal ? AbortSignal.any([connection.signal, options.signal]) : connection.signal
    }
  },
  afterError: async fetchRes => {
    const message = (await fetchRes.text()) || `网络请求失败 (${fetchRes.status})`
    const httpError = new HttpError(message, {
      status: fetchRes.status,
      statusText: fetchRes.statusText
    })
    return httpError
  }
})

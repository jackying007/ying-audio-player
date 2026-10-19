import { useState } from 'react'
import { toast } from 'sonner'
import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { normalizeServerUrl, useNetworkSettings } from '@/store/network-settings'
import { loadNetworkFolders } from '@/store/network-audio-store'

export const Route = createFileRoute('/settings')({ component: SettingsPage })
function SettingsPage() {
  const config = useNetworkSettings()
  const [serverUrl, setServerUrl] = useState(config.serverUrl)
  const [token, setToken] = useState(config.token)
  return (
    <div className="p-6">
      <form
        className="space-y-5"
        onSubmit={event => {
          event.preventDefault()
          try {
            const normalized = normalizeServerUrl(serverUrl)
            if (normalized && !token.trim()) throw new Error('请输入共享密钥')
            useNetworkSettings.setState({ serverUrl: normalized, token: token.trim() })
            setServerUrl(normalized)
            toast.success('设置已保存')
            if (normalized) void loadNetworkFolders()
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause))
          }
        }}
      >
        <div className="space-y-2">
          <label htmlFor="server-url" className="text-sm font-medium">
            服务端地址
          </label>
          <Input
            id="server-url"
            type="url"
            placeholder="http://localhost:8787"
            value={serverUrl}
            onChange={event => setServerUrl(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="server-token" className="text-sm font-medium">
            密钥
          </label>
          <Input
            id="server-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={event => setToken(event.target.value)}
          />
        </div>
        <p className="text-sm text-muted-foreground">地址和密钥保存在当前设备。密钥需与服务端 API_TOKEN 一致。</p>
        <Button type="submit">保存设置</Button>
      </form>
    </div>
  )
}

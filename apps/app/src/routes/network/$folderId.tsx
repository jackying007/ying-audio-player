import { useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { cn } from 'cn'
import { AudioList } from '@/routes/-shared/audio-list'
import { Button } from '@/components/ui/button'
import { PageLoading } from '@/components/page-loading'
import { loadNetworkAudios, playNetworkAudio, useNetworkAudioStore } from '@/store/network-audio-store'
import { useNetworkSettings } from '@/store/network-settings'
import { useAudioStore } from '@/store/audio-store'

export const Route = createFileRoute('/network/$folderId')({ component: NetworkFolderPage })
function NetworkFolderPage() {
  const { folderId } = Route.useParams()
  const folder = useNetworkAudioStore(state => state.folders.find(item => String(item.id) === folderId))
  const entry = useNetworkAudioStore(state => state.entries[folderId])
  const serverUrl = useNetworkSettings(state => state.serverUrl)
  const token = useNetworkSettings(state => state.token)
  const error = useAudioStore(state => state.error)
  useEffect(() => {
    if (serverUrl && token) void loadNetworkAudios(folderId)
  }, [folderId, serverUrl, token])
  if (!serverUrl || !token)
    return (
      <p className="p-4">
        请先在{' '}
        <Link to="/settings" className="underline">
          App 设置
        </Link>{' '}
        中配置服务端。
      </p>
    )
  if (!entry || (entry.loading && !entry.audios)) return <PageLoading />
  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{folder?.name ?? '网络音乐'}</h1>
          <p className="text-sm text-muted-foreground">{entry.audios?.length ?? 0} 首歌曲</p>
        </div>
        <Button variant="outline" size="sm" disabled={entry.loading} onClick={() => void loadNetworkAudios(folderId)}>
          <RefreshCw className={cn('size-4', entry.loading && 'animate-spin')} />
          刷新
        </Button>
      </div>
      {entry.error && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {entry.error}
        </p>
      )}
      {error && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {entry.audios?.length ? (
        <AudioList audios={entry.audios} onPlay={audio => playNetworkAudio(audio, folderId)} />
      ) : (
        !entry.error && <p className="p-3 text-sm text-muted-foreground">暂无歌曲，请从本地文件夹同步</p>
      )}
    </div>
  )
}

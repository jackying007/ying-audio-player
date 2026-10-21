import { useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { RefreshCw, Upload } from 'lucide-react'
import { cn } from 'cn'
import { PageLoading } from '@/components/page-loading'
import { AudioList } from '@/routes/-shared/audio-list'
import { syncLocalFolder, useNetworkAudioStore } from '@/store/network-audio-store'
import { useNetworkSettings } from '@/store/network-settings'
import { Button } from '@/components/ui/button'
import { useAudioStore } from '@/store/audio-store'
import { useAppStore } from '@/store/app-store'
import { loadFolderAudios, refreshFolder, playLocalAudio, useLocalAudioStore } from '@/store/local-audio-store'

export const Route = createFileRoute('/local/$folderId')({ component: LocalDetailPage })

function LocalDetailPage() {
  const { folderId } = Route.useParams()
  const playbackError = useAudioStore(state => state.error)
  const folder = useAppStore(state => state.localFolderList.find(item => String(item.id) === folderId))
  const entry = useLocalAudioStore(state => state[folderId])
  const removing = useAppStore(state => state.removingFolderIds.includes(Number(folderId)))
  const sync = useNetworkAudioStore(state => state.syncs[folderId])
  const configured = useNetworkSettings(state => !!state.serverUrl && !!state.token)

  useEffect(() => {
    void loadFolderAudios(folderId)
  }, [folderId])

  if (!entry || (entry.loading && !entry.audios)) return <PageLoading />
  const audios = entry.audios
  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{folder?.name ?? '本地音乐'}</h1>
          <p className="text-sm text-muted-foreground">{audios?.length ?? 0} 首歌曲 · 手动刷新更新列表</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={removing || entry.refreshing || entry.loading || sync?.running || !audios}
            onClick={() => refreshFolder(folderId)}
          >
            <RefreshCw className={cn('size-4', entry.refreshing && 'animate-spin')} />
            刷新
          </Button>
          {configured ? (
            <Button
              variant="outline"
              size="sm"
              disabled={removing || entry.refreshing || entry.loading || sync?.running || !audios?.length}
              onClick={() => void syncLocalFolder(folderId)}
            >
              <Upload className="size-4" />
              {sync?.running ? '同步中' : '同步'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings">
                <Upload className="size-4" />
                同步设置
              </Link>
            </Button>
          )}
        </div>
      </div>
      {sync && (
        <div className="px-3 pb-2 text-sm" aria-live="polite">
          {sync.running ? (
            <p>
              正在同步 {sync.completed}/{sync.total} 首，成功 {sync.succeeded} 首，跳过 {sync.skipped} 首
            </p>
          ) : (
            <p>{sync.message}</p>
          )}
          {!!sync.failures.length && (
            <details>
              <summary className="cursor-pointer text-destructive">{sync.failures.length} 首同步失败</summary>
              <ul className="max-h-40 overflow-auto break-all">
                {sync.failures.map((failure, index) => (
                  <li key={index}>{failure}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {entry.error && (
        <div role="alert" className="p-3 pb-0 flex items-center gap-3 text-sm text-destructive">
          <span>{entry.error}</span>
          <Button
            variant="destructive"
            size="sm"
            disabled={removing || entry.loading || entry.refreshing || sync?.running}
            onClick={() => (audios ? refreshFolder(folderId) : loadFolderAudios(folderId))}
          >
            重试
          </Button>
        </div>
      )}
      {playbackError && (
        <p role="alert" className="p-3 pb-0 text-sm text-destructive">
          {playbackError}
        </p>
      )}
      {!!entry.warnings?.length && (
        <details className="p-3 text-sm">
          <summary className="cursor-pointer">{entry.warnings.length} 个文件的部分信息无法读取</summary>
          <ul className="max-h-40 overflow-auto break-all">
            {entry.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {!!audios?.length && <AudioList audios={audios} onPlay={audio => playLocalAudio(audio, folderId)} />}
    </div>
  )
}

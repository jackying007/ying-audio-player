import { AudioLines } from 'lucide-react'
import { cn } from 'cn'
import { AudioCover } from './audio-cover'
import { useAudioStore, PlayState, type AudioInfo } from '@/store/audio-store'
import { isAndroid } from '@/lib/platform'

function formatDuration(ms: number | null) {
  if (ms == null) return '—'
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function formatSize(bytes: number | null) {
  if (bytes == null) return '—'
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}
export function AudioList({ audios, onPlay }: { audios: AudioInfo[]; onPlay: (audio: AudioInfo) => unknown }) {
  const current = useAudioStore(state => state.currentAudioInfo)
  const playState = useAudioStore(state => state.playState)
  return (
    <div className="flex-1 h-1 overflow-x-hidden overflow-y-auto">
      <div className="border-y flex items-center justify-between p-3 pl-0">
        <div className="flex">
          <div className="w-12 fc text-sm">#</div>
          <span>歌曲信息</span>
        </div>
        <div className="text-xs text-muted-foreground">时长大小</div>
      </div>
      {audios.map((audio, index) => {
        const active = current?.id === audio.id && (current?.source ?? 'local') === (audio.source ?? 'local')
        return (
          <div
            key={audio.link}
            className="border-b hover:bg-muted/50 flex items-center justify-between p-3 pl-0"
            onClick={isAndroid ? () => void onPlay(audio) : undefined}
            onDoubleClick={isAndroid ? undefined : () => void onPlay(audio)}
          >
            <div className="flex min-w-0">
              <div className="w-12 shrink-0 fc text-sm">
                {active ? (
                  <AudioLines
                    className={cn(
                      'size-5 text-primary [&_path]:origin-center [&_path]:transform-fill [&_path]:animate-wave [&_path:nth-child(2)]:[animation-delay:-0.3s] [&_path:nth-child(3)]:[animation-delay:-0.5s] [&_path:nth-child(4)]:[animation-delay:-0.7s] [&_path:nth-child(5)]:[animation-delay:-0.2s]',
                      playState !== PlayState.Playing && '[&_path]:[animation-play-state:paused]'
                    )}
                  />
                ) : (
                  <span className="text-muted-foreground">{index + 1}</span>
                )}
              </div>
              <AudioCover audio={audio} />
              <div className="min-w-0 ml-2">
                <p className={cn('text-sm cursor-pointer hover:underline truncate', active && 'text-primary')}>
                  {audio.name}
                </p>
                <p className="text-xs text-muted-foreground truncate" title={audio.artist ?? undefined}>
                  {audio.artist ?? '未知歌手'}
                </p>
                {audio.source !== 'network' && audio.scanError && (
                  <p className="text-xs text-destructive" title={audio.scanError}>
                    部分信息读取失败
                  </p>
                )}
              </div>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground text-end">
              <div>{formatDuration(audio.durationMs)}</div>
              <div>{formatSize(audio.fileSize)}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

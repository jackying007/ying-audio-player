import { useEffect, useRef, useState } from 'react'
import { Music2 } from 'lucide-react'
import type { AudioInfo } from '@/store/audio-store'
import { getNetworkCover } from '@/lib/network-cover'
import { localAudio } from '@/lib/local-audio'
import { useNetworkSettings } from '@/store/network-settings'

export function AudioCover({ audio }: { audio: AudioInfo }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<{
    audio: AudioInfo
    token: string
    serverUrl: string
    url?: string
    failed?: boolean
  }>()
  const token = useNetworkSettings(state => (audio.source === 'network' ? state.token : ''))
  const serverUrl = useNetworkSettings(state => (audio.source === 'network' ? state.serverUrl : ''))
  const current =
    result?.audio === audio && result.token === token && result.serverUrl === serverUrl ? result : undefined
  useEffect(() => {
    if (!audio.hasCover) return
    let disposed = false
    let objectUrl: string | undefined
    async function load() {
      try {
        let blob: Blob
        if (audio.source === 'network') {
          if (!audio.coverLink) throw new Error('歌曲封面地址不存在')
          blob = await getNetworkCover(audio.id, audio.coverLink)
        } else {
          const cover = await localAudio.getCover(audio.id)
          if (!cover) throw new Error('歌曲封面不存在')
          blob = new Blob([new Uint8Array(cover.data)], { type: cover.mime })
        }
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setResult({ audio, token, serverUrl, url: objectUrl })
      } catch {
        if (!disposed) setResult({ audio, token, serverUrl, failed: true })
      }
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer.disconnect()
          void load()
        }
      },
      { rootMargin: '100px' }
    )
    if (containerRef.current) observer.observe(containerRef.current)
    return () => {
      disposed = true
      observer.disconnect()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [audio, token, serverUrl])

  return (
    <div
      ref={containerRef}
      title={current?.failed ? '封面加载失败' : undefined}
      className="size-11 shrink-0 overflow-hidden rounded-md bg-muted flex items-center justify-center border"
    >
      {current?.url && !current.failed ? (
        <img
          key={current.url}
          src={current.url}
          alt="歌曲封面"
          className="size-full object-cover"
          onError={() => setResult(previous => (previous === current ? { ...previous, failed: true } : previous))}
        />
      ) : (
        <Music2 className="size-5 text-muted-foreground" />
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Music2 } from 'lucide-react'
import type { AudioInfo } from '@/store/audio-store'
import { networkApi } from '@/api'
import { useNetworkSettings } from '@/store/network-settings'

export function AudioCover({ cover, coverLink }: { cover: AudioInfo['cover']; coverLink?: string }) {
  const imageRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<{
    cover: AudioInfo['cover']
    coverLink?: string
    token: string
    serverUrl: string
  }>()
  const token = useNetworkSettings(state => state.token)
  const serverUrl = useNetworkSettings(state => state.serverUrl)
  const failed =
    !!failure &&
    failure.cover === cover &&
    failure.coverLink === coverLink &&
    failure.token === token &&
    failure.serverUrl === serverUrl
  const markFailed = () => setFailure({ cover, coverLink, token, serverUrl })
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let objectUrl: string | undefined
    async function load() {
      try {
        const blob = cover
          ? new Blob([new Uint8Array(cover.data)], { type: cover.mime })
          : coverLink
            ? await networkApi.getCover(coverLink, controller.signal)
            : undefined
        if (!blob || disposed) return
        objectUrl = URL.createObjectURL(blob)
        if (imageRef.current) imageRef.current.src = objectUrl
      } catch {
        if (!disposed) setFailure({ cover, coverLink, token, serverUrl })
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
      controller.abort()
      observer.disconnect()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [cover, coverLink, token, serverUrl])

  return (
    <div
      ref={containerRef}
      title={failed ? '封面加载失败' : undefined}
      className="size-11 shrink-0 overflow-hidden rounded-md bg-muted flex items-center justify-center border"
    >
      {(cover || coverLink) && !failed ? (
        <img ref={imageRef} alt="歌曲封面" className="size-full object-cover" onError={markFailed} />
      ) : (
        <Music2 className="size-5 text-muted-foreground" />
      )}
    </div>
  )
}

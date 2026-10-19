import { useEffect, useMemo, useRef } from 'react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { dayjs } from '@/lib/dayjs'
import { useAudioStore, ShowMode, setCurrentTime } from '@/store/audio-store'

function timeStrToNumber(timeStr: string) {
  const [minutes, seconds, milliseconds] = timeStr.split(/[:.]/).map(Number)
  const totalDuration = dayjs.duration({
    minutes,
    seconds,
    milliseconds
  })

  return totalDuration.asSeconds()
}

function isTimeInside(timeStr1: string, timeStr2?: string, target?: number) {
  if (!target) return false

  const time1 = timeStrToNumber(timeStr1)
  if (!timeStr2) {
    if (time1 <= target) return true
    return false
  }

  const time2 = timeStrToNumber(timeStr2)

  if (time1 <= target && time2 > target) return true

  return false
}

export function Lyric() {
  const showMode = useAudioStore(state => state.showMode)
  const currentTime = useAudioStore(state => state.currentTime)

  const currentLrc = useAudioStore(state => state.currentLrc)
  const lrcMap = useMemo(() => {
    if (!currentLrc) return {}
    const map: Record<string, string[]> = {}
    currentLrc.split('\n').forEach(el => {
      const time = el.substring(1, 10)
      const content = el.substring(11)
      map[time] = [...(map?.[time] || []), content]
    })
    return map
  }, [currentLrc])
  const lrcTimes = useMemo(() => Object.keys(lrcMap), [lrcMap])

  const lrcDivMapRef = useRef<Record<string, HTMLDivElement | null>>({})
  const scrolleWrapRef = useRef<HTMLDivElement>(null)

  const userScrollFlag = useRef(false)
  const userScrollFlagClearTimer = useRef<number>(undefined)
  const apiScrollFlag = useRef(false)
  const apiScrollFlagClearTimer = useRef<number>(undefined)
  const onLrcScroll: React.UIEventHandler<HTMLDivElement> = () => {
    if (apiScrollFlag.current) {
      clearTimeout(apiScrollFlagClearTimer.current)
      apiScrollFlagClearTimer.current = setTimeout(() => (apiScrollFlag.current = false), 16)
    } else {
      userScrollFlag.current = true
      clearTimeout(userScrollFlagClearTimer.current)
      userScrollFlagClearTimer.current = setTimeout(() => (userScrollFlag.current = false), 2000)
    }
  }

  useEffect(() => {
    if (scrolleWrapRef.current) {
      lrcDivMapRef.current = {}
      apiScrollFlag.current = false
      scrolleWrapRef.current.scrollTop = 0
    }
  }, [lrcTimes])

  const currentTimeStr = useMemo(() => {
    for (let i = 0; i < lrcTimes.length; i++) {
      const time1 = lrcTimes[i]
      const time2 = lrcTimes[i + 1]
      const isInside = isTimeInside(time1, time2, currentTime)
      if (isInside) return time1
    }
  }, [lrcTimes, currentTime])

  function scrollToLrcDiv(time: string) {
    apiScrollFlag.current = true
    lrcDivMapRef.current[time]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  }

  useEffect(() => {
    if (!userScrollFlag.current && !apiScrollFlag.current && currentTimeStr) scrollToLrcDiv(currentTimeStr)
  }, [currentTimeStr])

  return (
    <div
      className={cn(
        'fixed -bottom-full left-0 w-full h-full z-10 bg-accent transition-all duration-200 flex flex-col',
        showMode === ShowMode.Fullscreen && 'bottom-0'
      )}
    >
      <div className="flex-1 h-0 w-full overflow-y-auto overflow-x-hidden" ref={scrolleWrapRef} onScroll={onLrcScroll}>
        <div className="h-[50svh]" />
        {!lrcTimes.length && <div className="flex flex-col items-center">暂无歌词</div>}
        {lrcTimes.map((time, i) => (
          <div
            key={i}
            className="flex flex-col items-center my-4 relative py-3"
            ref={dom => {
              if (!dom) return
              lrcDivMapRef.current[time] = dom
            }}
          >
            <div
              className={cn(
                'text-center cursor-pointer transition-all opacity-50 hover:opacity-100 peer',
                currentTimeStr === time && 'scale-[1.1] opacity-100'
              )}
              onClick={() => {
                setCurrentTime(timeStrToNumber(time))
                scrollToLrcDiv(time)
              }}
            >
              {lrcMap[time].map((str, j) => (
                <div key={j}>{str}</div>
              ))}
            </div>
            <Separator
              className={cn(
                'transition-all duration-300 opacity-0 peer-hover:opacity-100 absolute top-0',
                time === currentTimeStr && 'opacity-100'
              )}
            />
            <Separator
              className={cn(
                'transition-all duration-300 opacity-0 peer-hover:opacity-100 absolute bottom-0',
                time === currentTimeStr && 'opacity-100'
              )}
            />
            <Badge className="absolute top-[50%] translate-y-[-50%] right-10 select-none transition-all duration-300 opacity-0 peer-hover:opacity-100">
              {dayjs.duration(timeStrToNumber(time), 'seconds').format('mm:ss')}
            </Badge>
          </div>
        ))}
        <div className="h-[50svh]" />
      </div>
      <div className="h-20 shrink-0 w-full" />
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ChevronUp,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
  ListMusic,
  Shuffle,
  Repeat1
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { dayjs } from '@/lib/dayjs'
import {
  togglePauseOrPlay,
  useAudioStore,
  setVolume,
  PlayState,
  setCurrentTime,
  ShowMode,
  playPrevAudio,
  playNextAudio,
  cyclePlayMode
} from '@/store/audio-store'
import { useAppStore } from '@/store/app-store'

const playModeDetails = {
  sequence: { icon: ListMusic, label: '列表顺序播放' },
  shuffle: { icon: Shuffle, label: '列表随机播放' },
  'repeat-one': { icon: Repeat1, label: '单曲循环' }
}

export function Controller() {
  const currentAudioInfo = useAudioStore(state => state.currentAudioInfo)
  const playState = useAudioStore(state => state.playState)
  const duration = useAudioStore(state => state.duration)
  const currentTime = useAudioStore(state => state.currentTime)
  const volume = useAppStore(state => state.volume)
  const playMode = useAppStore(state => state.playMode)
  const { icon: PlayModeIcon, label: playModeLabel } = playModeDetails[playMode]
  const showMode = useAudioStore(state => state.showMode)
  const error = useAudioStore(state => state.error)
  const warning = useAudioStore(state => state.warning)
  const volumeSliderValue = useMemo(() => [volume], [volume])
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false)
  const volumeCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearVolumeCloseTimer = () => {
    if (volumeCloseTimerRef.current !== null) {
      clearTimeout(volumeCloseTimerRef.current)
      volumeCloseTimerRef.current = null
    }
  }
  const openVolumePopover = () => {
    clearVolumeCloseTimer()
    setVolumePopoverOpen(true)
  }
  const closeVolumePopover = () => {
    clearVolumeCloseTimer()
    volumeCloseTimerRef.current = setTimeout(() => setVolumePopoverOpen(false), 200)
  }
  useEffect(() => () => clearVolumeCloseTimer(), [])
  const VolumeIcon = useMemo(() => {
    if (volume > 0.7) return Volume2
    if (volume > 0.35) return Volume1
    if (volume > 0) return Volume
    return VolumeX
  }, [volume])

  const isCurrentTimeSliderMovingRef = useRef(false)
  const [currentTimeSliderValue, setCurrentTimeSliderValue] = useState([0])
  useEffect(() => {
    if (currentTime === undefined || isCurrentTimeSliderMovingRef.current) return
    setCurrentTimeSliderValue([currentTime])
  }, [currentTime])

  return (
    <div
      className={cn(
        'fixed -bottom-22 left-0 w-full h-20 z-20 bg-white transition-all',
        showMode !== ShowMode.Hide && 'bottom-0'
      )}
    >
      <Slider
        value={currentTimeSliderValue}
        max={duration}
        step={1}
        onPointerDown={() => (isCurrentTimeSliderMovingRef.current = true)}
        onPointerUp={() => (isCurrentTimeSliderMovingRef.current = false)}
        onValueChange={val => setCurrentTimeSliderValue(val)}
        onValueCommit={val => setCurrentTime(val[0])}
      />

      <div className="p-4 h-full flex items-center justify-between">
        <div className="flex-1 flex items-center gap-x-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (showMode !== ShowMode.Fullscreen) {
                useAudioStore.setState({
                  showMode: ShowMode.Fullscreen
                })
              } else {
                useAudioStore.setState({
                  showMode: ShowMode.Bottom
                })
              }
            }}
          >
            <ChevronUp className={cn('w-6! h-6! transition-all', showMode === ShowMode.Fullscreen && 'rotate-180')} />
          </Button>
          <div className="min-w-0">
            <div className="text-lg truncate">{currentAudioInfo?.name}</div>
            {error && (
              <p role="alert" title={error} className="max-w-72 truncate text-xs text-destructive">
                {error}
              </p>
            )}
            {warning && (
              <p role="status" className="max-w-72 truncate text-xs text-muted-foreground">
                {warning}
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 flex justify-center items-center gap-x-2">
          <Button variant="ghost" size="default" onClick={playPrevAudio}>
            <SkipBack className="w-6 h-6" />
          </Button>
          <Button variant="ghost" size="default" onClick={togglePauseOrPlay}>
            {playState === PlayState.Playing ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
          </Button>
          <Button variant="ghost" size="default" onClick={playNextAudio}>
            <SkipForward className="w-6 h-6" />
          </Button>
        </div>

        <div className="flex-1 flex justify-end items-center gap-x-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={cyclePlayMode}
                aria-label={`当前模式：${playModeLabel}，点击切换播放模式`}
              >
                <PlayModeIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{playModeLabel}</TooltipContent>
          </Tooltip>
          <Popover open={volumePopoverOpen} onOpenChange={setVolumePopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" onMouseEnter={openVolumePopover} onMouseLeave={closeVolumePopover}>
                <VolumeIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              className="w-(--radix-popover-trigger-width) items-center px-0 py-3"
              onOpenAutoFocus={event => event.preventDefault()}
              onCloseAutoFocus={event => event.preventDefault()}
              onMouseEnter={openVolumePopover}
              onMouseLeave={closeVolumePopover}
            >
              <Slider
                orientation="vertical"
                className="h-24 data-vertical:min-h-24"
                value={volumeSliderValue}
                max={1}
                step={0.01}
                onValueChange={val => setVolume(val[0])}
              />
            </PopoverContent>
          </Popover>
          <div className="text-sm tabular-nums">
            {dayjs.duration(currentTimeSliderValue[0], 'seconds').format('mm:ss')} /{' '}
            {duration && dayjs.duration(duration, 'seconds').format('mm:ss')}
          </div>
        </div>
      </div>
    </div>
  )
}

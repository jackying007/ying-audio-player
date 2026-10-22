import { useEffect } from 'react'
import { exit, onBackButtonPress } from '@tauri-apps/api/app'
import { isAndroid } from '@/lib/platform'
import { dismissAndroidOverlay, handleAndroidBack } from '@/lib/android-back'
import { useAudioStore, ShowMode } from '@/store/audio-store'
import { router } from '@/router'

export function AndroidNavigation() {
  useEffect(() => {
    if (!isAndroid) return
    let disposed = false
    let unregister: (() => Promise<void>) | undefined
    const listener = onBackButtonPress(({ canGoBack }) => {
      handleAndroidBack({
        dismissOverlay: dismissAndroidOverlay,
        closePlayer: () => {
          if (useAudioStore.getState().showMode !== ShowMode.Fullscreen) return false
          useAudioStore.setState({ showMode: ShowMode.Bottom })
          return true
        },
        canGoBack,
        goBack: () => router.history.back(),
        exit: () => {
          void exit(0)
        }
      })
    })
    void listener
      .then(value => {
        if (disposed) void value.unregister()
        else unregister = () => value.unregister()
      })
      .catch(error => console.error('Android 返回键监听失败', error))
    return () => {
      disposed = true
      void unregister?.()
    }
  }, [])
  return null
}

import { isTauri } from '@tauri-apps/api/core'
import { supportsNativePlayback } from './platform'

const browser = typeof navigator === 'undefined' ? undefined : navigator
export const usesNativePlayback = supportsNativePlayback(isTauri(), browser?.userAgent ?? '', browser?.maxTouchPoints)

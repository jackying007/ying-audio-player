import { isAndroid } from './platform'

export function initializeAndroidWindowInsets() {
  if (!isAndroid) return

  const bridge = (window as Window & { AndroidWindowInsets?: { getTopInset(): number } }).AndroidWindowInsets
  const top = bridge?.getTopInset()
  if (typeof top === 'number' && Number.isFinite(top) && top >= 0) {
    document.documentElement.style.setProperty('--android-top-inset', `${top}px`)
  }
}

export function detectPlatform(userAgent: string, maxTouchPoints = 0) {
  const isAndroid = /Android/i.test(userAgent)
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)
  return { isAndroid, isIOS, isMobile: isAndroid || isIOS }
}

const browser = typeof navigator === 'undefined' ? undefined : navigator
export const { isAndroid, isIOS, isMobile } = detectPlatform(browser?.userAgent ?? '', browser?.maxTouchPoints)

export function supportsNativePlayback(isTauri: boolean, userAgent: string, maxTouchPoints = 0) {
  return isTauri && (detectPlatform(userAgent, maxTouchPoints).isMobile || /Windows NT|Macintosh/i.test(userAgent))
}

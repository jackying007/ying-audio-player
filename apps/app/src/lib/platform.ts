// Device platform is independent of the responsive viewport breakpoint.
export const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

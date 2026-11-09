export const songName = (filename: string) => filename.replace(/\.mp3$/i, '')
export const uploadSessionTtlMs = 30 * 60 * 1000
export const uploadLimits = { audio: 50 * 1024 * 1024, lyrics: 1024 * 1024, cover: 10 * 1024 * 1024 }
export type FileKind = keyof typeof uploadLimits
export const fileKinds = Object.keys(uploadLimits) as FileKind[]

export const checksumHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')

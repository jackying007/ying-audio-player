import { z } from 'zod'

export const fileName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    value => !/[\\/]/.test(value) && !Array.from(value).some(char => char.charCodeAt(0) < 32),
    '名称不能包含路径分隔符或控制字符'
  )
export const songName = (filename: string) => filename.replace(/\.mp3$/i, '')
export const audioMetadata = z.object({
  filename: fileName.refine(value => /\.mp3$/i.test(value) && !['', '.', '..'].includes(songName(value)), '只支持 MP3'),
  name: z.string().min(1).max(1000),
  title: z.string().max(4000).nullable(),
  artist: z.string().max(4000).nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  fileSize: z
    .number()
    .int()
    .nonnegative()
    .max(50 * 1024 * 1024)
    .nullable(),
  hasLyrics: z.boolean(),
  coverMime: z
    .string()
    .max(100)
    .regex(/^image\/[a-zA-Z0-9.+-]+$/)
    .nullable()
})
export type AudioMetadata = z.infer<typeof audioMetadata>
const fileHash = z.string().regex(/^[a-f0-9]{64}$/, '无效的 SHA-256')
export const uploadMetadata = audioMetadata
  .extend({ hash: fileHash, lyricsHash: fileHash.nullable() })
  .refine(value => value.hasLyrics === (value.lyricsHash !== null), '歌词 hash 与歌词声明不一致')
export const uploadSessionTtlMs = 30 * 60 * 1000
export const uploadLimits = { audio: 50 * 1024 * 1024, lyrics: 1024 * 1024, cover: 10 * 1024 * 1024 }
export type FileKind = keyof typeof uploadLimits

export const checksumHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')

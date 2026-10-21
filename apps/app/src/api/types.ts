export type NetworkFolder = { id: number; name: string }
export type NetworkMutationResult = { ok: boolean }
export type FileKind = 'audio' | 'lyrics' | 'cover'
export type UploadPlan = { id: string | null; unchanged: boolean; requiredFiles: FileKind[] }
export type AudioMetadata = {
  filename: string
  name: string
  title: string | null
  artist: string | null
  durationMs: number | null
  fileSize: number | null
  hasLyrics: boolean
  coverMime: string | null
}
export type NetworkAudio = AudioMetadata & {
  id: number
  folderId: number
  version: string
}
export type UploadMetadata = AudioMetadata & {
  hashes: { audio: string; lyrics: string | null; cover: string | null }
}

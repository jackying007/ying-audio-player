import { invoke } from '@tauri-apps/api/core'
import type { AudioInfo } from '@/store/audio-store'

export type LocalAudioFolder = {
  id: number
  name: string
  link: string
  scannedAt: number
}

export type ScanResult = {
  folder: LocalAudioFolder
  warnings: string[]
}

export const localAudio = {
  listFolders: () => invoke<LocalAudioFolder[]>('plugin:local-audio|list_folders'),
  importFolder: (path: string) => invoke<ScanResult>('plugin:local-audio|import_folder', { path }),
  listAudios: (folderId: number) => invoke<AudioInfo[]>('plugin:local-audio|list_audios', { folderId }),
  refreshFolder: (folderId: number) => invoke<ScanResult>('plugin:local-audio|refresh_folder', { folderId })
}

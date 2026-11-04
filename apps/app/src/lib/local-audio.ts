import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isMobile } from './platform'
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

export type LocalAudioInfo = AudioInfo & { filename: string }

export type LocalAudioCover = {
  mime: string
  data: number[]
}

export const localAudio = {
  pickFolder: () =>
    isMobile ? invoke<string | null>('plugin:local-audio|pick_folder') : open({ multiple: false, directory: true }),
  readAudio: async (audioId: number) =>
    new Uint8Array(await invoke<ArrayBuffer | number[]>('plugin:local-audio|read_audio', { audioId })),
  readLyrics: async (audioId: number) =>
    new Uint8Array(await invoke<ArrayBuffer | number[]>('plugin:local-audio|read_lyrics', { audioId })),
  listFolders: () => invoke<LocalAudioFolder[]>('plugin:local-audio|list_folders'),
  importFolder: (path: string) => invoke<ScanResult>('plugin:local-audio|import_folder', { path }),
  listAudios: (folderId: number) => invoke<LocalAudioInfo[]>('plugin:local-audio|list_audios', { folderId }),
  getCover: (audioId: number) => invoke<LocalAudioCover | null>('plugin:local-audio|get_cover', { audioId }),
  removeFolder: (folderId: number) => invoke<void>('plugin:local-audio|remove_folder', { folderId }),
  refreshFolder: (folderId: number) => invoke<ScanResult>('plugin:local-audio|refresh_folder', { folderId })
}

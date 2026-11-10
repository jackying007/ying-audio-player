import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { Children, type ReactElement } from 'react'
import type { AudioInfo } from '../../src/store/audio-store'

const platform = process.argv[2]
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android' : 'Windows' }
})
mock.module('../../src/store/audio-store', () => ({
  useAudioStore: () => undefined,
  PlayState: { Playing: 1 }
}))
mock.module('../../src/routes/-shared/audio-cover', () => ({ AudioCover: () => null }))

const { AudioList } = await import('../../src/routes/-shared/audio-list')
const song = { id: 1, link: 'song', name: '歌曲', durationMs: null, fileSize: null } as AudioInfo
const played: AudioInfo[] = []
const list = AudioList({ audios: [song], onPlay: audio => played.push(audio) })
const [, row] = Children.toArray(list.props.children) as ReactElement<{
  onClick?: () => void
  onDoubleClick?: () => void
}>[]

assert.equal(row.props.onClick, undefined)
row.props.onDoubleClick?.()
assert.deepEqual(played, [song])

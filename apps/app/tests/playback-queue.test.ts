import { describe, expect, test } from 'bun:test'
import { isPlayMode, PlaybackQueue } from '../src/lib/playback-queue'

const songs = ['a', 'b', 'c', 'd']

function queueAt(current?: string, links = songs) {
  const queue = new PlaybackQueue(() => 0.5)
  queue.reset(links, current)
  return queue
}

describe('sequential and repeat-one playback', () => {
  test('wraps in either direction and starts at the corresponding end without a current song', () => {
    const queue = queueAt('d')
    expect(queue.select('sequence', 'ended', 'd')).toBe('a')
    expect(queue.select('sequence', 'previous', 'a')).toBe('d')
    expect(queue.select('sequence', 'next', 'b')).toBe('c')
    expect(queue.select('sequence', 'next')).toBe('a')
    expect(queue.select('sequence', 'previous', 'removed')).toBe('d')
  })

  test('repeats only on natural completion in repeat-one mode', () => {
    const queue = queueAt('b')
    expect(queue.select('repeat-one', 'ended', 'b')).toBe('b')
    expect(queue.select('repeat-one', 'next', 'b')).toBe('c')
    expect(queue.select('repeat-one', 'previous', 'b')).toBe('a')
  })

  test('empty lists never select a song, even for repeat-one', () => {
    const queue = queueAt(undefined, [])
    for (const mode of ['sequence', 'shuffle', 'repeat-one'] as const) {
      for (const action of ['previous', 'next', 'ended'] as const) {
        expect(queue.select(mode, action, 'a')).toBeUndefined()
      }
    }
  })

  test('recognizes only supported persisted modes', () => {
    for (const value of [undefined, null, 0, {}, 'random', '']) expect(isPlayMode(value)).toBe(false)
    for (const value of ['sequence', 'shuffle', 'repeat-one']) expect(isPlayMode(value)).toBe(true)
  })
})

describe('shuffle playback', () => {
  test('counts the current song in the first round and plays every song once per round', () => {
    const queue = queueAt('a')
    let current = 'a'
    const firstRound = [current]
    for (let index = 0; index < songs.length - 1; index++) {
      current = queue.select('shuffle', 'ended', current)!
      firstRound.push(current)
    }
    expect([...firstRound].sort()).toEqual(songs)
    for (let round = 0; round < 5; round++) {
      const previous = current
      const played = []
      for (let index = 0; index < songs.length; index++) {
        current = queue.select('shuffle', 'next', current)!
        played.push(current)
      }
      expect(played[0]).not.toBe(previous)
      expect([...played].sort()).toEqual(songs)
    }
  })

  test('avoids a repeated boundary song when the shuffle puts it first', () => {
    const queue = new PlaybackQueue(() => 0.999)
    queue.reset(['a', 'b'], 'b')
    expect(queue.select('shuffle', 'next', 'b')).toBe('a')
    expect(queue.select('shuffle', 'next', 'a')).toBe('b')
    expect(queue.select('shuffle', 'next', 'b')).toBe('a')
  })

  test('previous and next follow history before consuming the remaining queue', () => {
    const queue = queueAt('a')
    expect(queue.select('shuffle', 'previous', 'a')).toBeUndefined()
    const second = queue.select('shuffle', 'next', 'a')!
    const third = queue.select('shuffle', 'next', second)!
    expect(queue.select('shuffle', 'previous', third)).toBe(second)
    expect(queue.select('shuffle', 'previous', second)).toBe('a')
    expect(queue.select('shuffle', 'previous', 'a')).toBeUndefined()
    expect(queue.select('shuffle', 'next', 'a')).toBe(second)
    expect(queue.select('shuffle', 'ended', second)).toBe(third)
    const fourth = queue.select('shuffle', 'next', third)!
    expect(new Set(['a', second, third, fourth]).size).toBe(4)
  })

  test('reset discards history and uses the selected song as the new starting point', () => {
    const queue = queueAt('a')
    queue.select('shuffle', 'next', 'a')
    queue.reset(['x', 'y', 'z'], 'y')
    expect(queue.select('shuffle', 'previous', 'y')).toBeUndefined()
    const next = queue.select('shuffle', 'next', 'y')!
    const last = queue.select('shuffle', 'next', next)!
    expect(new Set(['y', next, last])).toEqual(new Set(['x', 'y', 'z']))
    queue.reset(['x', 'z'], 'removed')
    expect(queue.select('shuffle', 'previous', 'removed')).toBeUndefined()
    const remaining = queue.select('shuffle', 'next', 'removed')!
    expect(['x', 'z']).toContain(remaining)
    expect(queue.select('shuffle', 'next', remaining)).not.toBe(remaining)
  })

  test('without a current song, plays a complete first round', () => {
    const queue = queueAt()
    const played: string[] = []
    for (let index = 0; index < songs.length; index++) {
      played.push(queue.select('shuffle', 'next', played[played.length - 1])!)
    }
    expect(played.sort()).toEqual(songs)
  })

  test('one-song playlists repeat in every mode', () => {
    for (const mode of ['sequence', 'shuffle', 'repeat-one'] as const) {
      const queue = queueAt('a', ['a'])
      expect(queue.select(mode, 'ended', 'a')).toBe('a')
      expect(queue.select(mode, 'next', 'a')).toBe('a')
      expect(queue.select(mode, 'previous', 'a')).toBe('a')
    }
  })
})

export type PlayMode = 'sequence' | 'shuffle' | 'repeat-one'
export type PlaybackAction = 'previous' | 'next' | 'ended'

export const playModes: PlayMode[] = ['sequence', 'shuffle', 'repeat-one']

export function isPlayMode(value: unknown): value is PlayMode {
  return value === 'sequence' || value === 'shuffle' || value === 'repeat-one'
}

export class PlaybackQueue {
  private links: string[] = []
  private remaining: string[] = []
  private history: string[] = []
  private cursor = -1

  constructor(private readonly random: () => number = Math.random) {}

  reset(links: string[], current?: string) {
    this.links = [...links]
    this.history = current && links.includes(current) ? [current] : []
    this.cursor = this.history.length - 1
    this.remaining = this.shuffle(links.filter(link => link !== current))
  }

  select(mode: PlayMode, action: PlaybackAction, current?: string): string | undefined {
    if (!this.links.length) return
    if (mode === 'repeat-one' && action === 'ended' && current) return current
    if (mode !== 'shuffle') {
      const index = current ? this.links.indexOf(current) : -1
      if (index === -1) return action === 'previous' ? this.links[this.links.length - 1] : this.links[0]
      const direction = action === 'previous' ? -1 : 1
      return this.links[(index + direction + this.links.length) % this.links.length]
    }

    if (action === 'previous') {
      if (this.cursor <= 0) return
      return this.history[--this.cursor]
    }
    if (this.cursor + 1 < this.history.length) return this.history[++this.cursor]
    if (!this.remaining.length) {
      this.remaining = this.shuffle(this.links)
      // A fresh round contains every song, but must not start with the last one played.
      if (this.remaining.length > 1 && this.remaining[0] === current) {
        const index = 1 + Math.floor(this.random() * (this.remaining.length - 1))
        ;[this.remaining[0], this.remaining[index]] = [this.remaining[index], this.remaining[0]]
      }
    }
    const next = this.remaining.shift()!
    this.history.push(next)
    this.cursor = this.history.length - 1
    return next
  }

  private shuffle(links: string[]) {
    const shuffled = [...links]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(this.random() * (index + 1))
      ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
    }
    return shuffled
  }
}

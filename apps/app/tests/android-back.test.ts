import { expect, test } from 'bun:test'
import { handleAndroidBack } from '../src/lib/android-back'

test.each([
  [true, true, true, ['overlay']],
  [false, true, true, ['overlay', 'player']],
  [false, false, true, ['overlay', 'player', 'back']],
  [false, false, false, ['overlay', 'player', 'exit']]
] as const)(
  'Android back closes overlays, then the player, then navigation (%s, %s, %s)',
  (overlay, player, canGoBack, expected) => {
    const calls: string[] = []
    handleAndroidBack({
      dismissOverlay: () => {
        calls.push('overlay')
        return overlay
      },
      closePlayer: () => {
        calls.push('player')
        return player
      },
      canGoBack,
      goBack: () => {
        calls.push('back')
      },
      exit: () => {
        calls.push('exit')
      }
    })
    expect(calls).toEqual([...expected])
  }
)

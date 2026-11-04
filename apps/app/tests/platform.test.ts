import { expect, test } from 'bun:test'
import { detectPlatform } from '../src/lib/platform'

test.each([
  ['iPhone', 5, true, false],
  ['iPad', 5, true, false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5, true, false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0, false, false],
  ['Android', 5, false, true],
  ['Windows', 5, false, false]
] as const)('recognizes platform from %s with %i touch points', (userAgent, touches, isIOS, isAndroid) => {
  expect(detectPlatform(userAgent, touches)).toEqual({ isIOS, isAndroid, isMobile: isIOS || isAndroid })
})

test.each(['ios', 'android', 'desktop'])('song activation uses the platform gesture: %s', platform => {
  const result = Bun.spawnSync([process.execPath, 'run', `${import.meta.dir}/fixtures/song-activation.ts`, platform])
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

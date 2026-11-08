import { expect, test } from 'bun:test'
import { detectPlatform, supportsNativePlayback } from '../src/lib/platform'

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

test('native playback is enabled only in supported Tauri hosts', () => {
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64)'
  for (const agent of [windows, mac, 'Mozilla/5.0 (Linux; Android 15)', 'Mozilla/5.0 (iPhone)']) {
    expect(supportsNativePlayback(true, agent)).toBe(true)
    expect(supportsNativePlayback(false, agent)).toBe(false)
  }
  expect(supportsNativePlayback(true, linux)).toBe(false)
})

import { expect, test } from 'bun:test'

// A fresh process keeps the Android platform and IPC mocks isolated from desktop playback tests.
test.each(['success', 'failure', 'finish-failure'])('Android cache transport: %s', scenario => {
  const result = Bun.spawnSync([
    process.execPath,
    'run',
    `${import.meta.dir}/fixtures/android-cache-transport.ts`,
    scenario
  ])
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

import { expect, test } from 'bun:test'

// Separate processes keep platform and IPC mocks isolated from the desktop tests.
for (const platform of ['android', 'ios']) {
  test.each(['success', 'failure', 'finish-failure'])(`${platform} cache transport: %s`, scenario => {
    const result = Bun.spawnSync([
      process.execPath,
      'run',
      `${import.meta.dir}/fixtures/mobile-cache-transport.ts`,
      scenario,
      platform
    ])
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
  })
}

import { expect, test } from 'bun:test'
import { fileHash } from '../src/lib/file-hash'

test('sync hashing works when Web Crypto is unavailable', async () => {
  const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  try {
    expect(await fileHash(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  } finally {
    Object.defineProperty(globalThis, 'crypto', crypto)
  }
})

export async function fileHash(bytes: Uint8Array) {
  // An HTTP development page on a physical device may lack Web Crypto.
  const subtle = globalThis.crypto?.subtle
  const hash = subtle
    ? new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes)))
    : (await import('@noble/hashes/sha2.js')).sha256(bytes)
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

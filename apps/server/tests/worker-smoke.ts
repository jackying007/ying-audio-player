// Run only against a disposable local Worker with its own --persist-to directory.
export {}
const origin = process.env.MUSIC_SMOKE_URL ?? 'http://127.0.0.1:8788'
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Smoke tests require a local Worker')
const base = `${origin}/api`
const token = process.env.MUSIC_SMOKE_TOKEN ?? 'local-smoke-key'
function authenticatedUrl(path: string) {
  const url = new URL(base + path)
  url.searchParams.set('authToken', token)
  return url
}

async function request(path: string, method = 'GET', body?: object | string) {
  const response = await fetch(authenticatedUrl(path), {
    method,
    headers: typeof body === 'object' ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'object' ? JSON.stringify(body) : body
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<Record<string, any>>
}
const folder = await request('/folder', 'POST', { name: 'Worker smoke test' })
const metadata = {
  folderId: folder.id,
  filename: 'smoke.mp3',
  name: 'Smoke',
  title: 'Metadata roundtrip',
  artist: 'Test',
  durationMs: 1000,
  fileSize: 5,
  hasLyrics: true,
  coverMime: 'image/jpeg'
}
const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')
const songHash = hash('music')
const lyricsHash = hash('[00:01]lyrics')
const upload = await request('/upload', 'POST', { ...metadata, hash: songHash, lyricsHash })
await request(`/upload/${upload.id}/audio`, 'PUT', 'music')
await request(`/upload/${upload.id}/lyrics`, 'PUT', '[00:01]lyrics')
await request(`/upload/${upload.id}/cover`, 'PUT', 'image')
const duplicate = await fetch(authenticatedUrl(`/upload/${upload.id}/audio`), { method: 'PUT', body: 'music' })
if (duplicate.status !== 409) throw new Error('Completed file writes must reject duplicate PUTs')
await request(`/upload/${upload.id}/commit`, 'POST')
const same = await request('/upload', 'POST', { ...metadata, hash: songHash, lyricsHash })
if (!same.unchanged || same.requiredFiles.length) throw new Error('Unchanged song was not skipped')
const lyricsUpdate = await request('/upload', 'POST', {
  ...metadata,
  hash: songHash,
  lyricsHash: hash('updated lyrics')
})
if (JSON.stringify(lyricsUpdate.requiredFiles) !== '["lyrics"]')
  throw new Error('Lyrics-only update must reuse audio and cover')
await request(`/upload/${lyricsUpdate.id}/lyrics`, 'PUT', 'updated lyrics')
await request(`/upload/${lyricsUpdate.id}/commit`, 'POST')
const bad = await request('/upload', 'POST', {
  ...metadata,
  filename: 'invalid.mp3',
  hasLyrics: false,
  coverMime: null,
  hash: songHash,
  lyricsHash: null
})
const badChecksum = await fetch(authenticatedUrl(`/upload/${bad.id}/audio`), { method: 'PUT', body: 'other' })
if (badChecksum.status !== 400)
  throw new Error(`Expected checksum rejection, got ${badChecksum.status}: ${await badChecksum.text()}`)
const rows = await request(`/audio/list?folderId=${folder.id}`)
const response = await fetch(authenticatedUrl(`/audio/${rows[0].id}?kind=audio`))
if ((await response.text()) !== 'music' || rows[0].title !== metadata.title)
  throw new Error('Audio or metadata did not roundtrip')
await request(`/upload/${upload.id}/commit`, 'POST')
const next = await request('/upload', 'POST', {
  ...metadata,
  hasLyrics: false,
  coverMime: null,
  hash: songHash,
  lyricsHash: null
})
if (next.requiredFiles.length) throw new Error('Removing optional files must reuse audio')
await request(`/upload/${next.id}/commit`, 'POST')
const updated = await request(`/audio/list?folderId=${folder.id}`)
if (updated.length !== 1 || updated[0].hasLyrics || updated[0].coverMime)
  throw new Error('Replacement did not clear optional files')
const cleanup = await fetch(`${origin}/__scheduled`)
if (!cleanup.ok) throw new Error(`Scheduled cleanup failed: ${await cleanup.text()}`)
console.log(
  'Worker/D1/R2 smoke passed: audio/lyrics hashes, skip, incremental upload, checksum verification, replacement, idempotency, cleanup.'
)

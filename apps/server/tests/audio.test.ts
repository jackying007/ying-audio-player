import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import worker from '../src/main'
import { cleanupAudio } from '../src/business/cleanup'
import { createDb } from '../src/db'
import { audioGarbage, audioUploads, audios as audioTable } from '../src/db/schema'

// Execute the production SQL against SQLite, including transactional D1 batches.
class TestD1 {
  sqlite = new Database(':memory:')
  constructor(migrate = true) {
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    if (!migrate) return
    const root = new URL('../drizzle/', import.meta.url)
    for (const name of readdirSync(root).sort()) {
      this.sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), 'utf8'))
    }
  }
  prepare(sql: string) {
    return new TestStatement(this, sql)
  }
  async batch(statements: TestStatement[]) {
    return this.sqlite.transaction(() => statements.map(statement => statement.execute()))()
  }
}
class TestStatement {
  values: SQLQueryBindings[] = []
  constructor(
    public db: TestD1,
    public sql: string
  ) {}
  bind(...values: SQLQueryBindings[]) {
    this.values = values
    return this
  }
  execute() {
    return { success: true, meta: this.db.sqlite.prepare(this.sql).run(...this.values) }
  }
  async run() {
    return this.execute()
  }
  async first() {
    return this.db.sqlite.prepare(this.sql).get(...this.values)
  }
  async all() {
    return { results: this.db.sqlite.prepare(this.sql).all(...this.values) }
  }
  async raw() {
    return this.db.sqlite.prepare(this.sql).values(...this.values)
  }
}
class TestBucket {
  objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>()
  async put(key: string, body: ReadableStream, options: { sha256?: string; httpMetadata: { contentType: string } }) {
    if (this.objects.has(key)) return null
    const bytes = await new Response(body).arrayBuffer()
    if (options.sha256 && new Bun.CryptoHasher('sha256').update(new Uint8Array(bytes)).digest('hex') !== options.sha256)
      throw new Error('SHA-256 checksum mismatch')
    this.objects.set(key, {
      bytes,
      contentType: options.httpMetadata.contentType
    })
    return { key }
  }
  async head(key: string) {
    const object = this.objects.get(key)
    return object ? { size: object.bytes.byteLength } : null
  }
  async get(key: string) {
    const object = this.objects.get(key)
    return object
      ? {
          size: object.bytes.byteLength,
          body: object.bytes,
          writeHttpMetadata(headers: Headers) {
            headers.set('Content-Type', object.contentType)
          }
        }
      : null
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
}

let db: TestD1
let bucket: TestBucket
let env: Env
const app = {
  request: async (url: string, init: RequestInit, env: Env) => worker.fetch(new Request(url, init), env)
}
const metadata = {
  filename: '音乐.MP3',
  name: '音乐',
  title: '标题',
  artist: '歌手',
  durationMs: 123456,
  fileSize: 5,
  hasLyrics: true,
  coverMime: 'image/jpeg'
}
async function request(path: string, method = 'GET', body?: unknown, token = 'test-key') {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  let payload: string | undefined
  if (typeof body === 'string') {
    payload = body
    headers['Content-Length'] = String(new TextEncoder().encode(body).byteLength)
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  return app.request(`http://localhost/api${path}`, { method, headers, body: payload }, env)
}
async function folder(name = '收藏') {
  const response = await request('/folders', 'POST', { name })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: number; name: string }
}
async function upload(folderId: number, patch = {}) {
  const response = await request(`/folders/${folderId}/uploads`, 'POST', { ...metadata, ...patch })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}
async function files(id: string, extras = true) {
  expect((await request(`/uploads/${id}/audio`, 'PUT', 'music')).status).toBe(200)
  if (extras) {
    expect((await request(`/uploads/${id}/lyrics`, 'PUT', '[00:01]歌词')).status).toBe(200)
    expect((await request(`/uploads/${id}/cover`, 'PUT', 'image')).status).toBe(200)
  }
}
async function audios(id: number) {
  return (await (await request(`/folders/${id}/audios`)).json()) as Array<Record<string, unknown>>
}
const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')
const fileContents = { audio: 'music', lyrics: '[00:01]歌词', cover: 'image' }
async function hashedPlan(folderId: number, patch = {}, contents = fileContents) {
  const data = { ...metadata, ...patch }
  const response = await request(`/folders/${folderId}/uploads`, 'POST', {
    ...data,
    hashes: {
      audio: hash(contents.audio),
      lyrics: data.hasLyrics ? hash(contents.lyrics) : null,
      cover: data.coverMime ? hash(contents.cover) : null
    }
  })
  expect([200, 201]).toContain(response.status)
  return (await response.json()) as {
    id: string | null
    unchanged: boolean
    requiredFiles: ('audio' | 'lyrics' | 'cover')[]
  }
}
async function publishHashed(folderId: number, contents = fileContents) {
  const plan = await hashedPlan(folderId, {}, contents)
  for (const kind of plan.requiredFiles)
    expect((await request(`/uploads/${plan.id}/${kind}`, 'PUT', contents[kind])).status).toBe(200)
  expect((await request(`/uploads/${plan.id}/commit`, 'POST')).status).toBe(200)
  return plan.id!
}

beforeEach(() => {
  db = new TestD1()
  bucket = new TestBucket()
  env = { D1: db, R2: bucket, API_TOKEN: 'test-key' } as unknown as Env
})
afterEach(() => db.sqlite.close())

describe('audio API', () => {
  test('identical hashes and metadata skip the song without creating another upload', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    expect(await hashedPlan(f.id)).toEqual({ id: null, unchanged: true, requiredFiles: [] })
    expect(await createDb(env.D1).select().from(audioUploads)).toHaveLength(1)
    expect((await audios(f.id))[0].version).toBe(id)
    expect(bucket.objects.size).toBe(3)
  })
  test('lyrics changes reuse the audio and cover objects', async () => {
    const f = await folder()
    const first = await publishHashed(f.id)
    const next = await hashedPlan(f.id, {}, { ...fileContents, lyrics: 'new lyrics' })
    expect(next.requiredFiles).toEqual(['lyrics'])
    expect((await request(`/uploads/${next.id}/lyrics`, 'PUT', 'new lyrics')).status).toBe(200)
    expect((await request(`/uploads/${next.id}/commit`, 'POST')).status).toBe(200)
    const [row] = await createDb(env.D1).select().from(audioTable)
    expect(row.audioKey).toBe(`music/${first}/audio`)
    expect(row.coverKey).toBe(`music/${first}/cover`)
    expect(row.lyricsHash).toBe(hash('new lyrics'))
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(3)
  })
  test('metadata-only changes and removing lyrics publish without uploading unchanged files', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const next = await hashedPlan(f.id, { artist: '新歌手', hasLyrics: false })
    expect(next.requiredFiles).toEqual([])
    expect(next.unchanged).toBe(false)
    expect((await request(`/uploads/${next.id}/commit`, 'POST')).status).toBe(200)
    expect((await audios(f.id))[0]).toMatchObject({ artist: '新歌手', hasLyrics: false })
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(2)
  })
  test('missing R2 objects are uploaded again even when their saved hashes match', async () => {
    const f = await folder()
    const first = await publishHashed(f.id)
    bucket.objects.delete(`music/${first}/audio`)
    const next = await hashedPlan(f.id)
    expect(next.requiredFiles).toEqual(['audio'])
  })
  test('R2 verifies the supplied hash before a file can be published', async () => {
    const f = await folder()
    const next = await hashedPlan(f.id)
    expect((await request(`/uploads/${next.id}/audio`, 'PUT', 'other')).status).toBe(400)
    expect((await request(`/uploads/${next.id}/commit`, 'POST')).status).toBe(409)
    expect(await audios(f.id)).toEqual([])
  })
  test('pending uploads protect reused objects while another sync replaces the song', async () => {
    const f = await folder()
    const first = await publishHashed(f.id)
    const pending = await hashedPlan(f.id, {}, { ...fileContents, lyrics: 'pending lyrics' })
    await publishHashed(f.id, { audio: 'other', lyrics: 'other lyrics', cover: 'other cover' })
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.has(`music/${first}/audio`)).toBe(true)
    expect(bucket.objects.has(`music/${first}/cover`)).toBe(true)
    await request(`/uploads/${pending.id}/lyrics`, 'PUT', 'pending lyrics')
    expect((await request(`/uploads/${pending.id}/commit`, 'POST')).status).toBe(200)
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(3)
  })
  test('numeric route IDs use the shared validator and reject invalid database IDs', async () => {
    for (const id of ['invalid', '0', '-1', '1.5', '9007199254740992']) {
      expect((await request(`/folders/${id}/audios`)).status).toBe(400)
      expect((await request(`/folders/${id}/uploads`, 'POST', metadata)).status).toBe(400)
      expect((await request(`/audios/${id}/audio`)).status).toBe(400)
    }
  })
  test('API lives directly under /api and the demo endpoint has been removed', async () => {
    expect((await request('/folders')).status).toBe(200)
    expect((await request('/music/folders')).status).toBe(404)
    expect((await request('/test-list')).status).toBe(404)
  })
  test('schema renames preserve existing folders, audio, uploads and object references', () => {
    const legacy = new TestD1(false)
    try {
      const root = new URL('../drizzle/', import.meta.url)
      const migrations = readdirSync(root).sort()
      const renameIndex = migrations.findIndex(name => name.endsWith('_camelCaseAudio'))
      expect(renameIndex).toBeGreaterThan(0)
      for (const name of migrations.slice(0, renameIndex)) {
        legacy.sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), 'utf8'))
      }
      legacy.sqlite.run('INSERT INTO music_folders (id, name) VALUES (?, ?)', [7, '收藏'])
      legacy.sqlite.run(
        `INSERT INTO music_audios (id, folder_id, filename, metadata, version, audio_key, lyrics_key, cover_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          11,
          7,
          metadata.filename,
          JSON.stringify(metadata),
          'old-version',
          'music/old/audio',
          'music/old/lyrics',
          'music/old/cover'
        ]
      )
      legacy.sqlite.run(
        'INSERT INTO music_uploads (id, folder_id, filename, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
        ['pending', 7, metadata.filename, JSON.stringify(metadata), 123456]
      )
      legacy.sqlite.run('INSERT INTO music_garbage (key) VALUES (?)', ['music/replaced/audio'])
      legacy.sqlite.run('INSERT INTO test (name, createdAt, updatedAt) VALUES (?, ?, ?)', ['demo', 1, 1])
      for (const name of migrations.slice(renameIndex)) {
        legacy.sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), 'utf8'))
      }
      expect(legacy.sqlite.query('SELECT * FROM audios').get()).toMatchObject({
        id: 11,
        folderId: 7,
        audioKey: 'music/old/audio',
        lyricsKey: 'music/old/lyrics',
        coverKey: 'music/old/cover',
        metadata: JSON.stringify(metadata)
      })
      expect(legacy.sqlite.query('SELECT * FROM folders').get()).toEqual({ id: 7, name: '收藏' })
      expect(
        legacy.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audioFolders'").get()
      ).toBeNull()
      expect(legacy.sqlite.query('SELECT * FROM audioUploads').get()).toMatchObject({ folderId: 7, createdAt: 123456 })
      expect(legacy.sqlite.query('SELECT * FROM audioGarbage').get()).toEqual({ key: 'music/replaced/audio' })
      expect(
        legacy.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test'").get()
      ).toBeNull()
      expect(legacy.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      legacy.sqlite.close()
    }
  })
  test('auth fails closed; preflight works without a token', async () => {
    expect((await request('/folders', 'GET', undefined, 'wrong')).status).toBe(401)
    env.API_TOKEN = ''
    expect((await request('/folders')).status).toBe(503)
    const response = await app.request(
      'http://localhost/api/folders',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:1420',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization'
        }
      },
      env
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:1420')
  })
  test('folders merge by exact name and metadata excludes local diagnostic fields', async () => {
    const a = await folder()
    expect((await folder()).id).toBe(a.id)
    const id = await upload(a.id, { scanError: 'local warning', link: 'C:/secret/music.mp3', id: 999 })
    await files(id)
    expect((await request(`/uploads/${id}/commit`, 'POST')).status).toBe(200)
    const rows = await audios(a.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: metadata.name,
      title: metadata.title,
      artist: metadata.artist,
      durationMs: metadata.durationMs,
      fileSize: 5,
      hasLyrics: true,
      coverMime: 'image/jpeg'
    })
    expect(rows[0]).not.toHaveProperty('scanError')
    expect(rows[0]).not.toHaveProperty('link')
    expect(await (await request(`/audios/${rows[0].id}/audio`)).text()).toBe('music')
  })
  test('incomplete replacement keeps old audio and metadata; commit is idempotent', async () => {
    const f = await folder()
    const first = await upload(f.id)
    await files(first)
    await request(`/uploads/${first}/commit`, 'POST')
    const second = await upload(f.id, { title: '新标题' })
    await files(second, false)
    expect((await request(`/uploads/${second}/commit`, 'POST')).status).toBe(409)
    expect((await audios(f.id))[0].title).toBe(metadata.title)
    await request(`/uploads/${second}/lyrics`, 'PUT', 'new lyrics')
    await request(`/uploads/${second}/cover`, 'PUT', 'new image')
    await request(`/uploads/${second}/commit`, 'POST')
    await request(`/uploads/${first}/commit`, 'POST')
    expect(await audios(f.id)).toHaveLength(1)
    expect((await audios(f.id))[0].title).toBe('新标题')
    expect((await request(`/uploads/${second}/audio`, 'PUT', 'other')).status).toBe(409)
  })
  test('replacement clears absent lyrics and cover, preserves audio ID and unrelated songs', async () => {
    const f = await folder()
    const old = await upload(f.id)
    await files(old)
    await request(`/uploads/${old}/commit`, 'POST')
    const oldRow = (await audios(f.id))[0]
    const other = await upload(f.id, { filename: 'other.mp3', hasLyrics: false, coverMime: null })
    await files(other, false)
    await request(`/uploads/${other}/commit`, 'POST')
    const next = await upload(f.id, { hasLyrics: false, coverMime: null })
    await files(next, false)
    await request(`/uploads/${next}/commit`, 'POST')
    const rows = await audios(f.id)
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.id === oldRow.id)).toMatchObject({ hasLyrics: false, coverMime: null })
    expect((await request(`/audios/${oldRow.id}/lyrics`)).status).toBe(404)
    expect((await request(`/audios/${oldRow.id}/cover`)).status).toBe(404)
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.has(`music/${old}/audio`)).toBe(false)
    expect(bucket.objects.has(`music/${next}/audio`)).toBe(true)
  })
  test('concurrent commits publish once without queuing the live version for deletion', async () => {
    const f = await folder()
    const id = await upload(f.id)
    await files(id)
    const responses = await Promise.all([
      request(`/uploads/${id}/commit`, 'POST'),
      request(`/uploads/${id}/commit`, 'POST')
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const rows = await audios(f.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(id)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.has(`music/${id}/audio`)).toBe(true)
  })
  test('failed R2 deletion retains the cleanup queue for retry', async () => {
    const f = await folder()
    const old = await upload(f.id)
    await files(old)
    await request(`/uploads/${old}/commit`, 'POST')
    const next = await upload(f.id)
    await files(next)
    await request(`/uploads/${next}/commit`, 'POST')
    const deleteObject = bucket.delete.bind(bucket)
    bucket.delete = async () => {
      throw new Error('R2 unavailable')
    }
    await expect(cleanupAudio(createDb(env.D1), env.R2)).rejects.toThrow('R2 unavailable')
    expect(await createDb(env.D1).select().from(audioGarbage)).toHaveLength(3)
    bucket.delete = deleteObject
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
    expect(bucket.objects.has(`music/${old}/audio`)).toBe(false)
    expect(bucket.objects.has(`music/${next}/audio`)).toBe(true)
  })
  test('rejects invalid paths, oversized files, changed local size and immutable upload overwrite', async () => {
    const f = await folder()
    expect((await request('/folders', 'POST', { name: '../bad' })).status).toBe(400)
    expect((await request(`/folders/${f.id}/uploads`, 'POST', { ...metadata, filename: '../bad.mp3' })).status).toBe(
      400
    )
    const id = await upload(f.id)
    expect((await request(`/uploads/${id}/audio`, 'PUT', 'changed-size')).status).toBe(400)
    const large = await app.request(
      `http://localhost/api/uploads/${id}/audio`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-key', 'Content-Length': String(51 * 1024 * 1024) },
        body: 'x'
      },
      env
    )
    expect(large.status).toBe(413)
    expect((await request(`/uploads/${id}/audio`, 'PUT', 'music')).status).toBe(200)
    expect((await request(`/uploads/${id}/audio`, 'PUT', 'other')).status).toBe(409)
  })
  test('cleanup removes expired staging objects but retains the live committed version', async () => {
    const f = await folder()
    const live = await upload(f.id)
    await files(live)
    await request(`/uploads/${live}/commit`, 'POST')
    const abandoned = await upload(f.id)
    await files(abandoned)
    await createDb(env.D1).update(audioUploads).set({ createdAt: 0 })
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.has(`music/${abandoned}/audio`)).toBe(false)
    expect(bucket.objects.has(`music/${live}/audio`)).toBe(true)
    expect(await (await request(`/audios/${(await audios(f.id))[0].id}/audio`)).text()).toBe('music')
  })
})

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
  request: async (url: string, init: RequestInit, env: Env) =>
    worker.fetch(new Request(url, init), env, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise)
    } as unknown as ExecutionContext)
}
let background: Promise<unknown>[] = []
async function finishBackground() {
  await Promise.all(background)
  background = []
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
  const headers: Record<string, string> = {}
  let payload: string | undefined
  if (typeof body === 'string') {
    payload = body
    headers['Content-Length'] = String(new TextEncoder().encode(body).byteLength)
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const url = new URL(`http://localhost/api${path}`)
  url.searchParams.set('authToken', token)
  return app.request(url.toString(), { method, headers, body: payload }, env)
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
  background = []
  db = new TestD1()
  bucket = new TestBucket()
  env = { D1: db, R2: bucket, API_TOKEN: 'test-key' } as unknown as Env
})
afterEach(async () => {
  await finishBackground()
  db.sqlite.close()
})

describe('audio API', () => {
  test('deleting a folder removes its songs and uploads and is idempotent', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    const pending = await upload(f.id)
    await files(pending)
    const [song] = await audios(f.id)
    expect((await request(`/folders/${f.id}`, 'DELETE')).status).toBe(200)
    expect(await (await request('/folders')).json()).toEqual([])
    expect((await request(`/folders/${f.id}/audios`)).status).toBe(404)
    expect((await request(`/audios/${song.id}/audio`)).status).toBe(404)
    expect((await request(`/uploads/${pending}/commit`, 'POST')).status).toBe(404)
    expect((await request(`/uploads/${id}/commit`, 'POST')).status).toBe(404)
    expect((await request(`/folders/${f.id}`, 'DELETE')).status).toBe(200)
    await finishBackground()
    expect(bucket.objects.size).toBe(0)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
  })
  test('deletes empty folders and permits recreating the same name with a new ID', async () => {
    const f = await folder()
    expect(await (await request(`/folders/${f.id}`, 'DELETE')).json()).toEqual({ ok: true })
    expect((await folder()).id).not.toBe(f.id)
  })
  test('folder deletion covers reused and legacy staged keys while preserving unrelated resources', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const reused = await hashedPlan(f.id, { title: 'pending metadata' })
    expect(reused.requiredFiles).toEqual([])
    const pending = await upload(f.id, { filename: 'legacy.mp3' })
    db.sqlite.run('UPDATE audioUploads SET audioKey = NULL, lyricsKey = NULL, coverKey = NULL WHERE id = ?', [pending])
    await files(pending)
    const other = await folder('其他')
    const otherId = await publishHashed(other.id)
    await request(`/folders/${f.id}`, 'DELETE')
    await finishBackground()
    expect([...bucket.objects.keys()].sort()).toEqual(
      ['audio', 'cover', 'lyrics'].map(kind => `music/${otherId}/${kind}`)
    )
    expect(await audios(other.id)).toHaveLength(1)
    expect((await request(`/uploads/${reused.id}/commit`, 'POST')).status).toBe(404)
  })
  test('folder deletion rolls back records and queued keys together when the transaction fails', async () => {
    const f = await folder()
    await publishHashed(f.id)
    db.sqlite.exec(
      "CREATE TRIGGER reject_folder_delete BEFORE DELETE ON folders BEGIN SELECT RAISE(ABORT, 'locked'); END"
    )
    expect((await request(`/folders/${f.id}`, 'DELETE')).status).toBe(500)
    expect(await audios(f.id)).toHaveLength(1)
    expect(await createDb(env.D1).select().from(audioUploads)).toHaveLength(1)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
    expect(bucket.objects.size).toBe(3)
  })
  test('deletion responds before R2 finishes and retries failed files without blocking other files', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    const deleteObject = bucket.delete.bind(bucket)
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    bucket.delete = async key => {
      await pending
      if (key === `music/${id}/audio`) throw new Error('R2 unavailable')
      await deleteObject(key)
    }
    const response = await request(`/folders/${f.id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(bucket.objects.size).toBe(3)
    release()
    await finishBackground()
    expect([...bucket.objects.keys()]).toEqual([`music/${id}/audio`])
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([{ key: `music/${id}/audio` }])
    bucket.delete = deleteObject
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(0)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
  })
  test.each([false, true])(
    'a late PUT cleans up after deletion already drained the queue (R2 failure: %s)',
    async failed => {
      const f = await folder()
      const id = await upload(f.id)
      const put = bucket.put.bind(bucket)
      let release!: () => void
      let started!: () => void
      const pending = new Promise<void>(resolve => {
        release = resolve
      })
      const ready = new Promise<void>(resolve => {
        started = resolve
      })
      bucket.put = async (...args) => {
        started()
        await pending
        return put(...args)
      }
      const uploading = request(`/uploads/${id}/audio`, 'PUT', 'music')
      await ready
      await request(`/folders/${f.id}`, 'DELETE')
      await finishBackground()
      const deleteObject = bucket.delete.bind(bucket)
      if (failed)
        bucket.delete = async () => {
          throw new Error('R2 unavailable')
        }
      release()
      expect((await uploading).status).toBe(409)
      expect(await createDb(env.D1).select().from(audioGarbage)).toEqual(failed ? [{ key: `music/${id}/audio` }] : [])
      bucket.delete = deleteObject
      await cleanupAudio(createDb(env.D1), env.R2)
      expect(bucket.objects.size).toBe(0)
    }
  )
  test('an overlapping cleaner cannot erase a late PUT retry after its compensating deletion fails', async () => {
    const f = await folder()
    const id = await upload(f.id, { hasLyrics: false, coverMime: null })
    const key = `music/${id}/audio`
    const put = bucket.put.bind(bucket)
    const putReady = Promise.withResolvers<void>()
    const putPending = Promise.withResolvers<void>()
    bucket.put = async (...args) => {
      putReady.resolve()
      await putPending.promise
      return put(...args)
    }
    const uploading = request(`/uploads/${id}/audio`, 'PUT', 'music')
    await putReady.promise
    const deleteObject = bucket.delete.bind(bucket)
    const cleanupReady = Promise.withResolvers<void>()
    const cleanupPending = Promise.withResolvers<void>()
    let first = true
    bucket.delete = async object => {
      if (object !== key) return deleteObject(object)
      if (!first) throw new Error('compensating deletion failed')
      first = false
      await deleteObject(object)
      cleanupReady.resolve()
      await cleanupPending.promise
    }
    await request(`/folders/${f.id}`, 'DELETE')
    await cleanupReady.promise
    putPending.resolve()
    expect((await uploading).status).toBe(409)
    cleanupPending.resolve()
    await finishBackground()
    expect(bucket.objects.has(key)).toBe(true)
    expect(await createDb(env.D1).select().from(audioGarbage)).toContainEqual({ key })
    bucket.delete = deleteObject
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(0)
  })
  test('a folder deleted during upload creation cannot receive another upload', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const head = bucket.head.bind(bucket)
    let deleted = false
    bucket.head = async key => {
      const result = await head(key)
      if (!deleted) {
        deleted = true
        await request(`/folders/${f.id}`, 'DELETE')
        await finishBackground()
      }
      return result
    }
    const response = await request(`/folders/${f.id}/uploads`, 'POST', {
      ...metadata,
      title: 'changed',
      hashes: { audio: hash(fileContents.audio), lyrics: hash(fileContents.lyrics), cover: hash(fileContents.cover) }
    })
    expect(response.status).toBe(404)
    expect(await createDb(env.D1).select().from(audioUploads)).toEqual([])
  })
  test('a commit paused during deletion cannot republish the deleted folder', async () => {
    const f = await folder()
    const id = await upload(f.id)
    await files(id)
    const head = bucket.head.bind(bucket)
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    bucket.head = async key => {
      const result = await head(key)
      started()
      await pending
      return result
    }
    const committing = request(`/uploads/${id}/commit`, 'POST')
    await ready
    await request(`/folders/${f.id}`, 'DELETE')
    await finishBackground()
    release()
    expect((await committing).status).toBe(409)
    expect(await createDb(env.D1).select().from(audioTable)).toEqual([])
    expect(bucket.objects.size).toBe(0)
  })
  test('cleanup traverses more than one page and protects objects referenced by another folder', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    const keys = Array.from({ length: 305 }, (_, i) => ({ key: `garbage/${String(i).padStart(3, '0')}` }))
    await createDb(env.D1)
      .insert(audioGarbage)
      .values([...keys, { key: `music/${id}/audio` }])
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
    expect(bucket.objects.size).toBe(3)
  })
  test('DELETE requires authentication, validates IDs and is allowed in browser preflight', async () => {
    expect((await request('/folders/1', 'DELETE', undefined, 'wrong')).status).toBe(401)
    for (const id of ['invalid', '0', '-1', '1.5', '9007199254740992']) {
      expect((await request(`/folders/${id}`, 'DELETE')).status).toBe(400)
    }
    const response = await app.request(
      'http://localhost/api/folders/1',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:1420',
          'Access-Control-Request-Method': 'DELETE',
          'Access-Control-Request-Headers': 'content-type'
        }
      },
      env
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
  })
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
    expect((await request('/folders')).status).toBe(200)
    expect((await request('/folders', 'GET', undefined, 'wrong')).status).toBe(401)
    expect((await request('/folders', 'GET', undefined, '')).status).toBe(401)
    expect((await request('/folders', 'GET', undefined, 'Bearer test-key')).status).toBe(401)
    expect((await app.request('http://localhost/api/folders', {}, env)).status).toBe(401)
    expect(
      (await app.request('http://localhost/api/folders', { headers: { Authorization: 'Bearer test-key' } }, env)).status
    ).toBe(401)
    expect(
      (
        await app.request(
          'http://localhost/api/folders?authToken=test-key',
          { headers: { Authorization: 'Bearer wrong' } },
          env
        )
      ).status
    ).toBe(200)
    env.API_TOKEN = ''
    expect((await request('/folders')).status).toBe(503)
    const response = await app.request(
      'http://localhost/api/folders',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:1420',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type'
        }
      },
      env
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:1420')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type')
  })
  test('query authentication decodes special characters and preserves media versions', async () => {
    const f = await folder()
    const id = await upload(f.id)
    await files(id)
    await request(`/uploads/${id}/commit`, 'POST')
    env.API_TOKEN = 'key+&= 中文'
    const response = await request(`/audios/1/audio?v=${id}`, 'GET', undefined, env.API_TOKEN)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('music')
    expect((await request('/audios/1/audio?v=old', 'GET', undefined, env.API_TOKEN)).status).toBe(409)
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
      `http://localhost/api/uploads/${id}/audio?authToken=test-key`,
      {
        method: 'PUT',
        headers: { 'Content-Length': String(51 * 1024 * 1024) },
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

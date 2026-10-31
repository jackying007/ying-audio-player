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
  objects = new Map<string, { bytes: ArrayBuffer; contentType: string; customMetadata: Record<string, string> }>()
  async put(
    key: string,
    body: ArrayBuffer,
    options: { sha256?: string; customMetadata: Record<string, string>; httpMetadata: { contentType: string } }
  ) {
    const bytes = await new Response(body).arrayBuffer()
    if (options.sha256 && new Bun.CryptoHasher('sha256').update(new Uint8Array(bytes)).digest('hex') !== options.sha256)
      throw new Error('SHA-256 checksum mismatch')
    this.objects.set(key, {
      bytes,
      contentType: options.httpMetadata.contentType,
      customMetadata: options.customMetadata
    })
    return { key }
  }
  async head(key: string) {
    const object = this.objects.get(key)
    return object
      ? {
          size: object.bytes.byteLength,
          checksums: { sha256: new Bun.CryptoHasher('sha256').update(new Uint8Array(object.bytes)).digest().buffer },
          customMetadata: object.customMetadata
        }
      : null
  }
  async get(key: string) {
    const object = this.objects.get(key)
    return object
      ? {
          size: object.bytes.byteLength,
          body: object.bytes,
          customMetadata: object.customMetadata,
          checksums: { sha256: new Bun.CryptoHasher('sha256').update(new Uint8Array(object.bytes)).digest().buffer },
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
  const data = { ...metadata, ...patch }
  const response = await request(`/folders/${folderId}/uploads`, 'POST', {
    ...data,
    hash: hash(fileContents.audio),
    lyricsHash: data.hasLyrics ? hash(fileContents.lyrics) : null
  })
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
    hash: hash(contents.audio),
    lyricsHash: data.hasLyrics ? hash(contents.lyrics) : null
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

describe('fixed-path audio API', () => {
  test('manual cleanup requires authentication and POST without changing queued resources', async () => {
    await createDb(env.D1).insert(audioGarbage).values({ key: 'orphan' })
    for (const token of ['', 'wrong', 'Bearer test-key'])
      expect((await request('/admin/cleanup', 'POST', undefined, token)).status).toBe(401)
    expect((await app.request('http://localhost/api/admin/cleanup', { method: 'POST' }, env)).status).toBe(401)
    expect((await request('/admin/cleanup')).status).toBe(404)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([{ key: 'orphan' }])
  })
  test('manual cleanup expires uploads, deletes unused objects and preserves published songs', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const expired = await upload(f.id, { filename: 'expired.mp3' })
    await files(expired)
    db.sqlite.prepare('UPDATE audioUploads SET createdAt = ? WHERE id = ?').run(Date.now() - 86400001, expired)
    const response = await request('/admin/cleanup', 'POST')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await createDb(env.D1).select().from(audioUploads)).toHaveLength(1)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
    expect([...bucket.objects.keys()].sort()).toEqual(['收藏/音乐/audio', '收藏/音乐/cover', '收藏/音乐/lyrics'])
    expect(await (await request('/admin/cleanup', 'POST')).json()).toEqual({ ok: true })
  })
  test('manual cleanup reports failures and retains queued resources for retry', async () => {
    await createDb(env.D1).insert(audioGarbage).values({ key: 'orphan' })
    bucket.delete = async () => {
      throw new Error('storage unavailable')
    }
    const response = await request('/admin/cleanup', 'POST')
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('storage unavailable')
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([{ key: 'orphan' }])
    bucket.delete = TestBucket.prototype.delete
    expect((await request('/admin/cleanup', 'POST')).status).toBe(200)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
  })
  test('deletes empty folders and permits recreating the same name with a new ID', async () => {
    const f = await folder()
    expect(await (await request(`/folders/${f.id}`, 'DELETE')).json()).toEqual({ ok: true })
    expect((await folder()).id).not.toBe(f.id)
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
  test('cleanup traverses more than one page and protects objects referenced by another folder', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    const keys = Array.from({ length: 305 }, (_, i) => ({ key: `garbage/${String(i).padStart(3, '0')}` }))
    await createDb(env.D1)
      .insert(audioGarbage)
      .values([...keys, { key: `${id}/audio` }])
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

  test('fixed paths preserve names, hashes and song ID across extension casing changes', async () => {
    const f = await folder()
    await publishHashed(f.id)
    expect([...bucket.objects.keys()].sort()).toEqual(['收藏/音乐/audio', '收藏/音乐/cover', '收藏/音乐/lyrics'])
    const first = (await audios(f.id))[0]
    expect(first.version).toBeUndefined()
    expect(first.hash).toBe(hash(fileContents.audio))
    const plan = await hashedPlan(f.id, { filename: '音乐.mp3' })
    expect(plan.requiredFiles).toEqual([])
    expect((await request('/uploads/' + plan.id + '/commit', 'POST')).status).toBe(200)
    const next = (await audios(f.id))[0]
    expect(next.id).toBe(first.id)
    expect(next.filename).toBe('音乐.mp3')
  })
  test('unchanged and metadata-only sync reuse objects', async () => {
    const f = await folder()
    await publishHashed(f.id)
    expect((await hashedPlan(f.id)).unchanged).toBe(true)
    const next = await hashedPlan(f.id, { title: '新标题' })
    expect(next.requiredFiles).toEqual([])
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    expect(bucket.objects.size).toBe(3)
  })
  test('replacement requires successful writes even when old objects exist, and blocks media until commit', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const row = (await audios(f.id))[0]
    const contents = { ...fileContents, audio: 'other' }
    const next = await hashedPlan(f.id, {}, contents)
    expect(next.requiredFiles).toEqual(['audio', 'cover'])
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(409)
    expect((await request('/uploads/' + next.id + '/audio', 'PUT', 'other')).status).toBe(200)
    expect((await request('/uploads/' + next.id + '/cover', 'PUT', fileContents.cover)).status).toBe(200)
    expect((await request('/audios/' + row.id + '/audio')).status).toBe(409)
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    expect(await (await request('/audios/' + row.id + '/audio?hash=' + hash(contents.audio))).text()).toBe('other')
    expect((await request('/audios/' + row.id + '/audio?hash=' + hash(fileContents.audio))).status).toBe(409)
  })
  test('same song sessions conflict atomically, different songs proceed', async () => {
    const f = await folder()
    const body = {
      ...metadata,
      hash: hash(fileContents.audio),
      lyricsHash: hash(fileContents.lyrics)
    }
    const responses = await Promise.all([
      request('/folders/' + f.id + '/uploads', 'POST', body),
      request('/folders/' + f.id + '/uploads', 'POST', { ...body, filename: '音乐.mp3' })
    ])
    expect(responses.map(r => r.status).sort()).toEqual([201, 409])
    await upload(f.id, { filename: 'other.mp3' })
  })
  test('failed checksum releases the session and forces all files to upload again', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const next = await hashedPlan(f.id, {}, { ...fileContents, audio: 'other' })
    expect((await request('/uploads/' + next.id + '/audio', 'PUT', 'wrong')).status).toBe(400)

    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(404)
    const retry = await hashedPlan(f.id)
    expect(retry.requiredFiles).toEqual(['audio', 'lyrics', 'cover'])
    await files(retry.id!)
    expect((await request('/uploads/' + retry.id + '/commit', 'POST')).status).toBe(200)
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(3)
  })
  test('removing lyrics and cover cleans only unused objects and folder deletion removes fixed paths', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const next = await hashedPlan(f.id, { hasLyrics: false, coverMime: null })
    expect(next.requiredFiles).toEqual([])
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    await cleanupAudio(createDb(env.D1), env.R2)
    expect([...bucket.objects.keys()]).toEqual(['收藏/音乐/audio'])
    expect((await request('/folders/' + f.id, 'DELETE')).status).toBe(200)
    await finishBackground()
    expect(bucket.objects.size).toBe(0)
  })
  test('missing objects require upload; invalid stems and absent hashes are rejected', async () => {
    const f = await folder()
    await publishHashed(f.id)
    bucket.objects.delete('收藏/音乐/audio')
    expect((await hashedPlan(f.id)).requiredFiles).toEqual(['audio'])
    for (const filename of ['.mp3', '..mp3', '...MP3'])
      expect((await request('/folders/' + f.id + '/uploads', 'POST', { ...metadata, filename })).status).toBe(400)
    expect((await request('/folders/' + f.id + '/uploads', 'POST', metadata)).status).toBe(400)
  })
  test('deletion responds before R2 finishes and retries failed files without blocking other files', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const deleteObject = bucket.delete.bind(bucket)
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    bucket.delete = async key => {
      await pending
      if (key === '收藏/音乐/audio') throw new Error('R2 unavailable')
      await deleteObject(key)
    }
    const response = await request(`/folders/${f.id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(bucket.objects.size).toBe(3)
    release()
    await finishBackground()
    expect([...bucket.objects.keys()]).toEqual(['收藏/音乐/audio'])
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([{ key: '收藏/音乐/audio' }])
    bucket.delete = deleteObject
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.size).toBe(0)
    expect(await createDb(env.D1).select().from(audioGarbage)).toEqual([])
  })
  test('an overlapping cleaner cannot erase a late PUT retry after its compensating deletion fails', async () => {
    const f = await folder()
    const id = await upload(f.id, { hasLyrics: false, coverMime: null })
    const key = '收藏/音乐/audio'
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
      hash: hash(fileContents.audio),
      lyricsHash: hash(fileContents.lyrics)
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
  test('rejects invalid paths, oversized files, changed local size and duplicate file writes', async () => {
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
  test('schema derives song identity from filename without storing songName', async () => {
    for (const table of ['audios', 'audioUploads']) {
      const columns = db.sqlite.query('PRAGMA table_info(' + table + ')').all() as { name: string }[]
      expect(columns.some(column => column.name === 'songName')).toBe(false)
      expect(columns.filter(column => /hash/i.test(column.name)).map(column => column.name)).toEqual([
        'hash',
        'lyricsHash'
      ])
    }
    const f = await folder()
    await publishHashed(f.id)
    expect(() =>
      db.sqlite.run('INSERT INTO audios(folderId,filename,metadata,audioKey,hash) VALUES(?,?,?,?,?)', [
        f.id,
        '音乐.mp3',
        JSON.stringify(metadata),
        'duplicate'
      ])
    ).toThrow()
    const first = (await audios(f.id))[0]
    const next = await hashedPlan(f.id, { filename: '音乐.mp3' })
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    expect((await audios(f.id))[0].id).toBe(first.id)
    await publishHashed((await folder('另一个文件夹')).id)
    expect(await audios(f.id)).toHaveLength(1)
  })
  test('expired first upload is queued before a new session removes its record', async () => {
    const f = await folder()
    const id = await upload(f.id)
    expect((await request('/uploads/' + id + '/audio', 'PUT', 'music')).status).toBe(200)
    db.sqlite.exec('UPDATE audioUploads SET createdAt=0')
    await upload(f.id, { filename: 'other.mp3' })
    await cleanupAudio(createDb(env.D1), env.R2)
    expect(bucket.objects.has('收藏/音乐/audio')).toBe(false)
  })
  test('duplicate PUT cannot mark a committed song as updating', async () => {
    const f = await folder()
    const id = await publishHashed(f.id)
    const row = (await audios(f.id))[0]
    expect((await request('/uploads/' + id + '/audio', 'PUT', 'music')).status).toBe(409)
    expect((await request('/audios/' + row.id + '/audio')).status).toBe(200)
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
      expect(await createDb(env.D1).select().from(audioGarbage)).toEqual(failed ? [{ key: '收藏/音乐/audio' }] : [])
      bucket.delete = deleteObject
      await cleanupAudio(createDb(env.D1), env.R2)
      expect(bucket.objects.size).toBe(0)
    }
  )
  test('GET cannot cache replacement bytes under the previous content hash', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const row = (await audios(f.id))[0]
    const get = bucket.get.bind(bucket)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    const wait = new Promise<void>(resolve => {
      release = resolve
    })
    bucket.get = async key => {
      started()
      await wait
      return get(key)
    }
    const reading = request('/audios/' + row.id + '/audio?hash=' + hash(fileContents.audio))
    await ready
    await publishHashed(f.id, { ...fileContents, audio: 'other' })
    release()
    expect((await reading).status).toBe(409)
  })
  test('truncated body releases the session for immediate repair', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const next = await hashedPlan(f.id, {}, { ...fileContents, audio: 'other' })
    const response = await app.request(
      'http://localhost/api/uploads/' + next.id + '/audio?authToken=test-key',
      { method: 'PUT', headers: { 'Content-Length': '5' }, body: 'bad' },
      env
    )
    expect(response.status).toBe(400)
    const retry = await hashedPlan(f.id)
    expect(retry.requiredFiles).toEqual(['audio', 'lyrics', 'cover'])
  })
  test('lyrics changes upload only lyrics; covers follow audio without a cover hash', async () => {
    const f = await folder()
    await publishHashed(f.id)
    const contents = { ...fileContents, lyrics: 'changed' }
    const next = await hashedPlan(f.id, {}, contents)
    expect(next.requiredFiles).toEqual(['lyrics'])
    expect((await request('/uploads/' + next.id + '/lyrics', 'PUT', contents.lyrics)).status).toBe(200)
    expect((await request('/uploads/' + next.id + '/commit', 'POST')).status).toBe(200)
    const row = (await audios(f.id))[0]
    expect(row.hash).toBe(hash(fileContents.audio))
    expect(row.lyricsHash).toBe(hash(contents.lyrics))
    expect((await request('/audios/' + row.id + '/lyrics?hash=' + hash(fileContents.lyrics))).status).toBe(409)
    expect(await (await request('/audios/' + row.id + '/lyrics?hash=' + hash(contents.lyrics))).text()).toBe('changed')
    const audioUpdate = await hashedPlan(f.id, {}, { ...contents, audio: 'other', cover: 'new cover' })
    expect(audioUpdate.requiredFiles).toEqual(['audio', 'cover'])
  })
})

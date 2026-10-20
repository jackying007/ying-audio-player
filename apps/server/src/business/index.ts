import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { and, asc, eq, exists, gte, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { AppEnv } from '@/db'
import { audioGarbage, audios, audioUploads, folders } from '@/db/schema'
import { paramId, zValidator } from './base.validator'
import { uploadMetadata, fileName, objectKey, uploadLimits, type AudioMetadata, type FileKind } from './metadata'

type StoredAudio = typeof audios.$inferSelect
const excludedAudio = alias(audios, 'excluded')
const parseMetadata = (value: string) => JSON.parse(value) as AudioMetadata

function publicAudio(row: StoredAudio) {
  const { coverMime, ...metadata } = parseMetadata(row.metadata)
  return { ...metadata, id: row.id, folderId: row.folderId, version: row.version, coverMime }
}

export const api = new Hono<AppEnv>()

api.get('/folders', async c =>
  c.json(await c.get('db').select().from(folders).orderBy(asc(folders.name), asc(folders.id)))
)
api.post('/folders', zValidator('json', z.object({ name: fileName })), async c => {
  const { name } = c.req.valid('json')
  const db = c.get('db')
  await db.insert(folders).values({ name }).onConflictDoNothing()
  return c.json(await db.select().from(folders).where(eq(folders.name, name)).get())
})
api.get('/folders/:id/audios', paramId, async c => {
  const { id } = c.req.valid('param')
  const db = c.get('db')
  if (!(await db.select({ id: folders.id }).from(folders).where(eq(folders.id, id)).get()))
    throw new HTTPException(404, { message: '文件夹不存在' })
  const rows = await db
    .select()
    .from(audios)
    .where(eq(audios.folderId, id))
    .orderBy(sql`${audios.filename} collate nocase`, asc(audios.id))
  return c.json(rows.map(publicAudio))
})
api.post('/folders/:id/uploads', paramId, zValidator('json', uploadMetadata), async c => {
  const { id: folderId } = c.req.valid('param')
  const db = c.get('db')
  if (!(await db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId)).get()))
    throw new HTTPException(404, { message: '文件夹不存在' })
  const id = crypto.randomUUID()
  const { hashes, ...metadata } = c.req.valid('json')
  const serialized = JSON.stringify(metadata)
  const existing = await db
    .select()
    .from(audios)
    .where(and(eq(audios.folderId, folderId), eq(audios.filename, metadata.filename)))
    .get()
  const requiredFiles: FileKind[] = []
  async function resolveKey(kind: FileKind, present: boolean) {
    if (!present) return null
    const key = existing?.[`${kind}Key`]
    const hash = hashes?.[kind]
    if (hash && hash === existing?.[`${kind}Hash`] && key && (await c.env.R2.head(key))) return key
    requiredFiles.push(kind)
    return objectKey(id, kind)
  }
  const audioKey = await resolveKey('audio', true)
  const lyricsKey = await resolveKey('lyrics', metadata.hasLyrics)
  const coverKey = await resolveKey('cover', metadata.coverMime !== null)
  if (existing && !requiredFiles.length && existing.metadata === serialized) {
    return c.json({ id: null, unchanged: true, requiredFiles })
  }
  await db.insert(audioUploads).values({
    id,
    folderId,
    filename: metadata.filename,
    metadata: serialized,
    audioKey,
    lyricsKey,
    coverKey,
    audioHash: hashes?.audio ?? null,
    lyricsHash: hashes?.lyrics ?? null,
    coverHash: hashes?.cover ?? null,
    createdAt: Date.now()
  })
  return c.json({ id, unchanged: false, requiredFiles }, 201)
})

api.put('/uploads/:id/:kind', async c => {
  const id = c.req.param('id')
  const db = c.get('db')
  const kind = c.req.param('kind') as FileKind
  if (!Object.hasOwn(uploadLimits, kind)) throw new HTTPException(404, { message: '文件类型不存在' })
  const upload = await db.select().from(audioUploads).where(eq(audioUploads.id, id)).get()
  if (!upload || upload.createdAt < Date.now() - 86400000)
    throw new HTTPException(404, { message: '上传不存在或已过期' })
  if (upload.committed) throw new HTTPException(409, { message: '上传已经提交' })
  const metadata = parseMetadata(upload.metadata)
  if ((kind === 'lyrics' && !metadata.hasLyrics) || (kind === 'cover' && !metadata.coverMime))
    throw new HTTPException(400, { message: '该歌曲未声明此文件' })
  const length = Number(c.req.header('Content-Length'))
  if (!c.req.raw.body || !Number.isSafeInteger(length) || length <= 0)
    throw new HTTPException(400, { message: '需要非空文件及 Content-Length' })
  if (length > uploadLimits[kind]) throw new HTTPException(413, { message: '文件超过大小限制' })
  if (kind === 'audio' && metadata.fileSize !== null && length !== metadata.fileSize)
    throw new HTTPException(400, { message: '文件大小与索引不符，请刷新本地列表后重试' })
  const key = objectKey(id, kind)
  if (upload[`${kind}Key`] && upload[`${kind}Key`] !== key)
    throw new HTTPException(409, { message: '该文件内容未变化，无需上传' })
  // Each staged object is immutable, even if PUT races with commit or another PUT.
  const stored = await c.env.R2.put(key, c.req.raw.body, {
    sha256: upload[`${kind}Hash`] ?? undefined,
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType:
        kind === 'audio' ? 'audio/mpeg' : kind === 'lyrics' ? 'text/plain; charset=utf-8' : metadata.coverMime!
    }
  }).catch(error => {
    if (error instanceof Error && /checksum|sha-?256/i.test(error.message))
      throw new HTTPException(400, { message: '文件 hash 校验失败，请重新同步' })
    throw error
  })
  if (!stored) throw new HTTPException(409, { message: '文件已上传，请重新同步该歌曲' })
  const remaining = await db.select().from(audioUploads).where(eq(audioUploads.id, id)).get()
  if (!remaining || (!remaining.committed && remaining.createdAt < Date.now() - 86400000)) {
    await c.env.R2.delete(key)
    throw new HTTPException(409, { message: '上传已过期，请重新同步' })
  }
  return c.json({ ok: true })
})

api.post('/uploads/:id/commit', async c => {
  const id = c.req.param('id')
  const db = c.get('db')
  const upload = await db.select().from(audioUploads).where(eq(audioUploads.id, id)).get()
  if (!upload) throw new HTTPException(404, { message: '上传不存在' })
  if (upload.committed) return c.json({ ok: true })
  if (upload.createdAt < Date.now() - 86400000) throw new HTTPException(409, { message: '上传已过期' })
  const metadata = parseMetadata(upload.metadata)
  const audioKey = upload.audioKey ?? objectKey(id, 'audio')
  const lyricsKey = metadata.hasLyrics ? (upload.lyricsKey ?? objectKey(id, 'lyrics')) : null
  const coverKey = metadata.coverMime ? (upload.coverKey ?? objectKey(id, 'cover')) : null
  const objects = await Promise.all(
    [audioKey, lyricsKey, coverKey].filter((key): key is string => !!key).map(key => c.env.R2.head(key))
  )
  if (objects.some(object => !object)) throw new HTTPException(409, { message: '文件尚未上传完整' })
  const pending = db
    .select({ id: audioUploads.id })
    .from(audioUploads)
    .where(and(eq(audioUploads.id, id), eq(audioUploads.committed, 0)))
  const queueOld = (column: 'audioKey' | 'lyricsKey' | 'coverKey') =>
    db
      .insert(audioGarbage)
      .select(
        db
          .select({ key: sql<string>`${audios[column]}`.as('key') })
          .from(audios)
          .where(
            and(
              eq(audios.folderId, upload.folderId),
              eq(audios.filename, upload.filename),
              isNotNull(audios[column]),
              exists(pending)
            )
          )
      )
      .onConflictDoNothing()
  const cutoff = Date.now() - 86400000
  // D1 批次具有原子性。请将“待处理/过期”检查包含在查询逻辑内，
  // 从而确保重复提交或定时清理操作不会导致已过时的上传内容被重新发布。
  const results = await db.batch([
    queueOld('audioKey'),
    queueOld('lyricsKey'),
    queueOld('coverKey'),
    db
      .insert(audios)
      .select(
        db
          .select({
            folderId: audioUploads.folderId,
            filename: audioUploads.filename,
            metadata: audioUploads.metadata,
            version: audioUploads.id,
            audioKey: sql<string>`${audioKey}`.as('audioKey'),
            lyricsKey: sql<string | null>`${lyricsKey}`.as('lyricsKey'),
            coverKey: sql<string | null>`${coverKey}`.as('coverKey'),
            audioHash: audioUploads.audioHash,
            lyricsHash: audioUploads.lyricsHash,
            coverHash: audioUploads.coverHash
          })
          .from(audioUploads)
          .where(and(eq(audioUploads.id, id), eq(audioUploads.committed, 0), gte(audioUploads.createdAt, cutoff)))
      )
      .onConflictDoUpdate({
        target: [audios.folderId, audios.filename],
        set: {
          metadata: excludedAudio.metadata,
          version: excludedAudio.version,
          audioKey: excludedAudio.audioKey,
          lyricsKey: excludedAudio.lyricsKey,
          coverKey: excludedAudio.coverKey,
          audioHash: excludedAudio.audioHash,
          lyricsHash: excludedAudio.lyricsHash,
          coverHash: excludedAudio.coverHash
        }
      }),
    db
      .update(audioUploads)
      .set({ committed: 1 })
      .where(and(eq(audioUploads.id, id), gte(audioUploads.createdAt, cutoff)))
  ])
  if (!results[4].meta.changes) throw new HTTPException(409, { message: '上传已过期，请重新同步' })
  return c.json({ ok: true })
})

api.get('/audios/:id/:kind', paramId, async c => {
  const { id } = c.req.valid('param')
  const kind = c.req.param('kind') as FileKind
  if (!Object.hasOwn(uploadLimits, kind)) throw new HTTPException(404, { message: '文件类型不存在' })
  const row = await c.get('db').select().from(audios).where(eq(audios.id, id)).get()
  if (!row) throw new HTTPException(404, { message: '歌曲不存在' })
  if (c.req.query('v') && c.req.query('v') !== row.version)
    throw new HTTPException(409, { message: '歌曲已更新，请刷新网络列表' })
  const key = row[`${kind}Key`]
  if (!key) throw new HTTPException(404, { message: '文件不存在' })
  const object = await c.env.R2.get(key)
  if (!object) throw new HTTPException(404, { message: '文件不存在' })
  const headers = new Headers({ 'X-Content-Type-Options': 'nosniff' })
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=2592000')
  headers.set('Content-Length', String(object.size))
  return new Response(object.body, { headers })
})

import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { and, asc, eq, exists, gte, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { AppEnv } from '@/db'
import { audioGarbage, audios, audioUploads, folders, songNameSql } from '@/db/schema'
import { paramId, zValidator } from './base.validator'
import {
  uploadMetadata,
  fileName,
  objectKey,
  songName,
  checksumHex,
  uploadLimits,
  type AudioMetadata,
  type FileKind
} from './metadata'
import { cleanupAudio, cleanupAudioGarbage, queueAudioCleanupRetry } from './cleanup'

type StoredAudio = typeof audios.$inferSelect
const excludedAudio = alias(audios, 'excluded')
const parseMetadata = (value: string) => JSON.parse(value) as AudioMetadata

async function readUpload(body: ReadableStream<Uint8Array>, length: number) {
  const bytes = new Uint8Array(length)
  const reader = body.getReader()
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > length) throw new HTTPException(400, { message: '文件大小与声明不符' })
      bytes.set(value, offset)
      offset += value.byteLength
    }
    if (offset !== length) throw new HTTPException(400, { message: '文件大小与声明不符' })
    return bytes
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

function publicAudio(row: StoredAudio) {
  const { coverMime, ...metadata } = parseMetadata(row.metadata)
  return {
    ...metadata,
    id: row.id,
    folderId: row.folderId,
    hash: row.hash,
    lyricsHash: row.lyricsHash,
    coverMime
  }
}

export const api = new Hono<AppEnv>()

api.post('/admin/cleanup', async c => {
  await cleanupAudio(c.get('db'), c.env.R2)
  return c.json({ ok: true })
})

api.get('/folders', async c => c.json(await c.get('db').select().from(folders).orderBy(asc(folders.id))))
api.post('/folders', zValidator('json', z.object({ name: fileName })), async c => {
  const { name } = c.req.valid('json')
  const db = c.get('db')
  await db.insert(folders).values({ name }).onConflictDoNothing()
  return c.json(await db.select().from(folders).where(eq(folders.name, name)).get())
})
api.delete('/folders/:id', paramId, async c => {
  const { id } = c.req.valid('param')
  const db = c.get('db')
  const queueKeys = (table: typeof audios | typeof audioUploads, kind: FileKind) =>
    db
      .insert(audioGarbage)
      .select(
        db
          .select({
            key: sql<string>`${table[`${kind}Key`]}`.as('key')
          })
          .from(table)
          .where(and(eq(table.folderId, id), isNotNull(table[`${kind}Key`])))
      )
      .onConflictDoNothing()
  await db.batch([
    queueKeys(audios, 'audio'),
    ...(['lyrics', 'cover'] as const).map(kind => queueKeys(audios, kind)),
    ...(['audio', 'lyrics', 'cover'] as const).map(kind => queueKeys(audioUploads, kind)),
    db.delete(audioUploads).where(eq(audioUploads.folderId, id)),
    db.delete(audios).where(eq(audios.folderId, id)),
    db.delete(folders).where(eq(folders.id, id))
  ])
  c.executionCtx.waitUntil(
    cleanupAudioGarbage(db, c.env.R2).catch(() => {
      console.error('网络文件夹资源清理未完成，将由定时任务重试')
    })
  )
  return c.json({ ok: true })
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
  const folder = await db.select().from(folders).where(eq(folders.id, folderId)).get()
  if (!folder) throw new HTTPException(404, { message: '文件夹不存在' })
  const expired = and(
    eq(audioUploads.folderId, folderId),
    eq(audioUploads.committed, 0),
    sql`${audioUploads.createdAt} < ${Date.now() - 86400000}`
  )
  const queueExpired = (kind: FileKind) =>
    db
      .insert(audioGarbage)
      .select(
        db
          .select({ key: sql<string>`${audioUploads[`${kind}Key`]}`.as('key') })
          .from(audioUploads)
          .where(and(expired, isNotNull(audioUploads[`${kind}Key`])))
      )
      .onConflictDoNothing()
  await db.batch([
    queueExpired('audio'),
    queueExpired('lyrics'),
    queueExpired('cover'),
    db.delete(audioUploads).where(expired)
  ])
  const pendingUpload = await db
    .select()
    .from(audioUploads)
    .where(
      and(
        eq(audioUploads.folderId, folderId),
        eq(songNameSql(audioUploads.filename), songName(c.req.valid('json').filename)),
        eq(audioUploads.committed, 0)
      )
    )
    .get()
  if (pendingUpload) throw new HTTPException(409, { message: '该歌曲正在上传，请稍后重试' })
  const id = crypto.randomUUID()
  const { hash, lyricsHash, ...metadata } = c.req.valid('json')
  const serialized = JSON.stringify(metadata)
  const existing = await db
    .select()
    .from(audios)
    .where(and(eq(audios.folderId, folderId), eq(songNameSql(audios.filename), songName(metadata.filename))))
    .get()
  const requiredFiles: FileKind[] = []
  async function resolveKey(kind: FileKind, present: boolean) {
    if (!present) return null
    const key = existing?.[`${kind}Key`]
    const unchanged = kind === 'lyrics' ? lyricsHash === existing?.lyricsHash : hash === existing?.hash
    if (!existing?.updating && unchanged && key && (await c.env.R2.head(key))) return key
    requiredFiles.push(kind)
    return objectKey(folder!.name, metadata.filename, kind)
  }
  const audioKey = await resolveKey('audio', true)
  const lyricsKey = await resolveKey('lyrics', metadata.hasLyrics)
  const coverKey = await resolveKey('cover', metadata.coverMime !== null)
  if (existing && !requiredFiles.length && existing.metadata === serialized) {
    return c.json({ id: null, unchanged: true, requiredFiles })
  }
  await db
    .insert(audioUploads)
    .values({
      id,
      folderId,
      filename: metadata.filename,
      requiredFiles: JSON.stringify(requiredFiles),
      metadata: serialized,
      audioKey,
      lyricsKey,
      coverKey,
      hash,
      lyricsHash,
      createdAt: Date.now()
    })
    .catch(async error => {
      if (!(await db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId)).get()))
        throw new HTTPException(404, { message: '文件夹不存在' })
      if (
        await db
          .select()
          .from(audioUploads)
          .where(
            and(
              eq(audioUploads.folderId, folderId),
              eq(songNameSql(audioUploads.filename), songName(metadata.filename)),
              eq(audioUploads.committed, 0)
            )
          )
          .get()
      )
        throw new HTTPException(409, { message: '该歌曲正在上传，请稍后重试' })
      throw error
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
  const key = upload[`${kind}Key`]!
  const required = JSON.parse(upload.requiredFiles) as FileKind[]
  if (!required.includes(kind)) throw new HTTPException(409, { message: '该文件内容未变化，无需上传' })
  const writing = 'writing_' + kind
  const claimed = await db
    .update(audioUploads)
    .set({ uploadedFiles: sql`json_insert(${audioUploads.uploadedFiles}, '$[#]', ${writing})` })
    .where(
      and(
        eq(audioUploads.id, id),
        eq(audioUploads.committed, 0),
        sql`NOT EXISTS (SELECT 1 FROM json_each(${audioUploads.uploadedFiles}) WHERE value IN (${kind}, ${writing}))`
      )
    )
    .returning({ id: audioUploads.id })
    .get()
  if (!claimed) throw new HTTPException(409, { message: '文件已上传或正在上传' })
  await db
    .update(audios)
    .set({ updating: 1 })
    .where(and(eq(audios.folderId, upload.folderId), eq(songNameSql(audios.filename), songName(upload.filename))))
  // Fixed objects are overwritten only after marking the published song unavailable.
  const stored = await (async () => {
    const bytes = await readUpload(c.req.raw.body!, length)
    const checksum = checksumHex(await crypto.subtle.digest('SHA-256', bytes))
    return c.env.R2.put(key, bytes, {
      sha256: kind === 'audio' ? upload.hash : kind === 'lyrics' ? upload.lyricsHash! : checksum,
      customMetadata: { contentHash: kind === 'lyrics' ? upload.lyricsHash! : upload.hash },
      httpMetadata: {
        contentType:
          kind === 'audio' ? 'audio/mpeg' : kind === 'lyrics' ? 'text/plain; charset=utf-8' : metadata.coverMime!
      }
    })
  })().catch(async error => {
    // Release the failed session so a fresh sync can repair the fixed objects immediately.
    const keys = [upload.audioKey, upload.lyricsKey, upload.coverKey].filter((key): key is string => key !== null)
    await db.batch([
      db
        .insert(audioGarbage)
        .values(keys.map(key => ({ key })))
        .onConflictDoNothing(),
      db.delete(audioUploads).where(eq(audioUploads.id, id))
    ])
    if (error instanceof Error && /checksum|sha-?256/i.test(error.message))
      throw new HTTPException(400, { message: '文件 hash 校验失败，请重新同步' })
    throw error
  })
  if (!stored) throw new HTTPException(409, { message: '文件已上传，请重新同步该歌曲' })
  const remaining = await db.select().from(audioUploads).where(eq(audioUploads.id, id)).get()
  if (!remaining || (!remaining.committed && remaining.createdAt < Date.now() - 86400000)) {
    // A DELETE may already have drained its queue before this late PUT completed.
    await c.env.R2.delete(key).catch(async () => {
      await queueAudioCleanupRetry(db, key)
      console.error('过期上传资源清理未完成，将由定时任务重试')
    })
    throw new HTTPException(409, { message: '上传已过期，请重新同步' })
  }
  await db.run(
    sql`UPDATE ${audioUploads} SET uploadedFiles = replace(uploadedFiles, ${JSON.stringify(writing)}, ${JSON.stringify(kind)}) WHERE id = ${id} AND committed = 0`
  )
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
  const audioKey = upload.audioKey!
  const lyricsKey = metadata.hasLyrics ? upload.lyricsKey : null
  const coverKey = metadata.coverMime ? upload.coverKey : null
  const uploaded = JSON.parse(upload.uploadedFiles) as FileKind[]
  if ((JSON.parse(upload.requiredFiles) as FileKind[]).some(kind => !uploaded.includes(kind)))
    throw new HTTPException(409, { message: '文件尚未上传完整' })
  const keys = [audioKey, lyricsKey, coverKey]
  const objects = await Promise.all(keys.map(key => (key ? c.env.R2.head(key) : null)))
  if (objects.some((object, index) => keys[index] && !object))
    throw new HTTPException(409, { message: '文件尚未上传完整' })
  const checksums = objects.map(object => (object?.checksums.sha256 ? checksumHex(object.checksums.sha256) : null))
  if (checksums[0] !== upload.hash || (metadata.hasLyrics && checksums[1] !== upload.lyricsHash)) {
    await db.batch([
      db
        .insert(audioGarbage)
        .values(keys.filter((key): key is string => !!key).map(key => ({ key })))
        .onConflictDoNothing(),
      db.delete(audioUploads).where(eq(audioUploads.id, id))
    ])
    throw new HTTPException(400, { message: '歌曲 hash 校验失败，请重新同步' })
  }
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
              eq(songNameSql(audios.filename), songName(upload.filename)),
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
            updating: sql<number>`0`.as('updating'),
            audioKey: sql<string>`${audioKey}`.as('audioKey'),
            lyricsKey: sql<string | null>`${lyricsKey}`.as('lyricsKey'),
            coverKey: sql<string | null>`${coverKey}`.as('coverKey'),
            hash: audioUploads.hash,
            lyricsHash: audioUploads.lyricsHash
          })
          .from(audioUploads)
          .where(and(eq(audioUploads.id, id), eq(audioUploads.committed, 0), gte(audioUploads.createdAt, cutoff)))
      )
      .onConflictDoUpdate({
        target: [audios.folderId, songNameSql(audios.filename)],
        set: {
          metadata: excludedAudio.metadata,
          filename: excludedAudio.filename,
          updating: 0,
          audioKey: excludedAudio.audioKey,
          lyricsKey: excludedAudio.lyricsKey,
          coverKey: excludedAudio.coverKey,
          hash: excludedAudio.hash,
          lyricsHash: excludedAudio.lyricsHash
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
  if (row.updating) throw new HTTPException(409, { message: '歌曲更新尚未完成，请重新同步' })
  const expectedHash = kind === 'lyrics' ? row.lyricsHash : row.hash
  if (c.req.query('hash') && c.req.query('hash') !== expectedHash)
    throw new HTTPException(409, { message: '歌曲已更新，请刷新网络列表' })
  const key = row[`${kind}Key`]
  if (!key) throw new HTTPException(404, { message: '文件不存在' })
  const object = await c.env.R2.get(key)
  if (!object) throw new HTTPException(404, { message: '文件不存在' })
  if (object.customMetadata?.contentHash !== expectedHash)
    throw new HTTPException(409, { message: '歌曲已更新，请刷新网络列表' })
  const headers = new Headers({ 'X-Content-Type-Options': 'nosniff' })
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=2592000')
  headers.set('Content-Length', String(object.size))
  return new Response(object.body, { headers })
})

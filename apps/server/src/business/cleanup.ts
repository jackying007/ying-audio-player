import { and, eq, exists, gte, lt, notExists, or } from 'drizzle-orm'
import type { Database } from '@/db'
import { audioGarbage, audios, audioUploads } from '@/db/schema'
import { objectKey } from './metadata'

export async function cleanupAudio(db: Database, bucket: R2Bucket) {
  const expired = await db
    .select()
    .from(audioUploads)
    .where(lt(audioUploads.createdAt, Date.now() - 24 * 60 * 60 * 1000))
    .limit(100)
  for (const upload of expired) {
    const { id } = upload
    const keys = new Set(
      (['audio', 'lyrics', 'cover'] as const)
        .flatMap(kind => [objectKey(id, kind), upload[`${kind}Key`]])
        .filter((key): key is string => key !== null)
    )
    // Live versions are protected below, including committed uploads.
    await db.batch([
      db
        .insert(audioGarbage)
        .values([...keys].map(key => ({ key })))
        .onConflictDoNothing(),
      db.delete(audioUploads).where(eq(audioUploads.id, id))
    ])
  }
  const liveReference = db
    .select({ id: audios.id })
    .from(audios)
    .where(
      or(
        eq(audios.audioKey, audioGarbage.key),
        eq(audios.lyricsKey, audioGarbage.key),
        eq(audios.coverKey, audioGarbage.key)
      )
    )
  // 未完成的同步可能复用旧版本对象；在提交或过期之前也必须保留这些引用。
  const pendingReference = db
    .select({ id: audioUploads.id })
    .from(audioUploads)
    .where(
      and(
        eq(audioUploads.committed, 0),
        gte(audioUploads.createdAt, Date.now() - 86400000),
        or(
          eq(audioUploads.audioKey, audioGarbage.key),
          eq(audioUploads.lyricsKey, audioGarbage.key),
          eq(audioUploads.coverKey, audioGarbage.key)
        )
      )
    )
  const garbage = await db
    .select()
    .from(audioGarbage)
    .where(and(notExists(liveReference), notExists(pendingReference)))
    .limit(300)
  for (const { key } of garbage) {
    await bucket.delete(key)
    await db.delete(audioGarbage).where(eq(audioGarbage.key, key))
  }
  // Drop queue entries which are still the current version, without deleting their objects.
  await db.delete(audioGarbage).where(exists(liveReference))
}

import { and, asc, eq, exists, gt, gte, lt, notExists, or, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { uploadSessionTtlMs } from './metadata'
import { audioGarbage, audios, audioUploads } from '@/db/schema'

export async function queueAudioCleanupRetry(db: Database, key: string) {
  // Renew SQLite's implicit rowid so an older cleaner cannot erase this retry.
  // A rowid collision fails rather than replacing an unrelated queue entry.
  await db.run(sql`INSERT INTO ${audioGarbage} (rowid, key) VALUES (random(), ${key})
    ON CONFLICT (key) DO UPDATE SET rowid = excluded.rowid`)
}

export async function cleanupAudio(db: Database, bucket: R2Bucket) {
  const expired = await db
    .select()
    .from(audioUploads)
    .where(lt(audioUploads.createdAt, Date.now() - uploadSessionTtlMs))
    .limit(100)
  for (const upload of expired) {
    const { id } = upload
    const keys = new Set(
      (['audio', 'lyrics', 'cover'] as const)
        .map(kind => upload[`${kind}Key`])
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
  await cleanupAudioGarbage(db, bucket)
}

export async function cleanupAudioGarbage(db: Database, bucket: R2Bucket) {
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
        gte(audioUploads.createdAt, Date.now() - uploadSessionTtlMs),
        or(
          eq(audioUploads.audioKey, audioGarbage.key),
          eq(audioUploads.lyricsKey, audioGarbage.key),
          eq(audioUploads.coverKey, audioGarbage.key)
        )
      )
    )
  let cursor: string | undefined
  let failure: unknown
  let hasMore = true
  do {
    const garbage = await db
      .select({ key: audioGarbage.key, generation: sql<string>`cast(${audioGarbage}.rowid as text)` })
      .from(audioGarbage)
      .where(
        and(notExists(liveReference), notExists(pendingReference), cursor ? gt(audioGarbage.key, cursor) : undefined)
      )
      .orderBy(asc(audioGarbage.key))
      .limit(300)
    if (!garbage.length) break
    for (const { key, generation } of garbage) {
      try {
        await bucket.delete(key)
        await db.delete(audioGarbage).where(and(eq(audioGarbage.key, key), sql`${audioGarbage}.rowid = ${generation}`))
      } catch (error) {
        failure = error
      }
    }
    cursor = garbage[garbage.length - 1].key
    hasMore = garbage.length === 300
  } while (hasMore)
  // Drop queue entries which are still the current version, without deleting their objects.
  await db.delete(audioGarbage).where(exists(liveReference))
  if (failure) throw failure
}

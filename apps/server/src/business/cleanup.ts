import { and, asc, eq, exists, gt, gte, lt, notExists, or, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { objectKeys, objectKeySql } from './object-keys'
import { fileKinds, uploadSessionTtlMs } from './metadata'
import { audioGarbageTable, audioTable, audioUploadTable } from '@/db/schema'

export async function queueAudioCleanupRetry(db: Database, key: string) {
  // Renew SQLite's implicit rowid so an older cleaner cannot erase this retry.
  // A rowid collision fails rather than replacing an unrelated queue entry.
  await db.run(sql`INSERT INTO ${audioGarbageTable} (rowid, key) VALUES (random(), ${key})
    ON CONFLICT (key) DO UPDATE SET rowid = excluded.rowid`)
}

export async function cleanupAudio(db: Database, bucket: R2Bucket) {
  const expired = await db
    .select()
    .from(audioUploadTable)
    .where(lt(audioUploadTable.createdAt, Date.now() - uploadSessionTtlMs))
    .limit(100)
  for (const upload of expired) {
    const { id } = upload
    const keys = objectKeys(upload)
    // Live versions are protected below, including committed uploads.
    await db.batch([
      db
        .insert(audioGarbageTable)
        .values(keys.map(key => ({ key })))
        .onConflictDoNothing(),
      db.delete(audioUploadTable).where(eq(audioUploadTable.id, id))
    ])
  }
  await cleanupAudioGarbage(db, bucket)
}

export async function cleanupAudioGarbage(db: Database, bucket: R2Bucket) {
  const liveReference = db
    .select({ id: audioTable.id })
    .from(audioTable)
    .where(or(...fileKinds.map(kind => eq(objectKeySql(audioTable, kind), audioGarbageTable.key))))
  // 未完成的同步可能复用旧版本对象；在提交或过期之前也必须保留这些引用。
  const pendingReference = db
    .select({ id: audioUploadTable.id })
    .from(audioUploadTable)
    .where(
      and(
        eq(audioUploadTable.committed, 0),
        gte(audioUploadTable.createdAt, Date.now() - uploadSessionTtlMs),
        or(...fileKinds.map(kind => eq(objectKeySql(audioUploadTable, kind), audioGarbageTable.key)))
      )
    )
  let cursor: string | undefined
  let failure: unknown
  let hasMore = true
  do {
    const garbage = await db
      .select({ key: audioGarbageTable.key, generation: sql<string>`cast(${audioGarbageTable}.rowid as text)` })
      .from(audioGarbageTable)
      .where(
        and(
          notExists(liveReference),
          notExists(pendingReference),
          cursor ? gt(audioGarbageTable.key, cursor) : undefined
        )
      )
      .orderBy(asc(audioGarbageTable.key))
      .limit(300)
    if (!garbage.length) break
    for (const { key, generation } of garbage) {
      try {
        await bucket.delete(key)
        await db
          .delete(audioGarbageTable)
          .where(and(eq(audioGarbageTable.key, key), sql`${audioGarbageTable}.rowid = ${generation}`))
      } catch (error) {
        failure = error
      }
    }
    cursor = garbage[garbage.length - 1].key
    hasMore = garbage.length === 300
  } while (hasMore)
  // Drop queue entries which are still the current version, without deleting their objects.
  await db.delete(audioGarbageTable).where(exists(liveReference))
  if (failure) throw failure
}

import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const folders = sqliteTable('folders', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique()
})

// 已发布的歌曲记录，供列表查询和播放使用；覆盖上传未完成时仍指向旧版本。
export const audios = sqliteTable(
  'audios',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    folderId: integer()
      .notNull()
      .references(() => folders.id),
    filename: text().notNull(),
    metadata: text().notNull(),
    version: text().notNull(),
    audioKey: text().notNull(),
    lyricsKey: text(),
    coverKey: text(),
    // 各文件的 SHA-256；旧记录为空，首次同步后建立，用于跳过内容相同的上传。
    audioHash: text(),
    lyricsHash: text(),
    coverHash: text()
  },
  table => [uniqueIndex('audioIndex').on(table.folderId, table.filename)]
)

// 单次上传的暂存记录，与 audios 暂时保存相似的元数据，但不作为歌曲列表使用。
// D1 和 R2 无法在同一个事务中提交，因此先暂存元数据并上传文件，
// 确认音频、歌词、封面全部上传成功后，再通过 D1 事务发布到 audios。
// 这样覆盖上传中途失败时，已发布歌曲的文件引用和元数据仍保持旧版本。
// 已提交记录短期保留以支持幂等提交；超过 24 小时的暂存记录由定时任务清理。
export const audioUploads = sqliteTable('audioUploads', {
  id: text().primaryKey(),
  folderId: integer()
    .notNull()
    .references(() => folders.id),
  filename: text().notNull(),
  metadata: text().notNull(),
  // 保存本次发布使用的文件引用：未变化的文件复用已发布对象，变化的文件使用本次上传对象。
  audioKey: text(),
  lyricsKey: text(),
  coverKey: text(),
  audioHash: text(),
  lyricsHash: text(),
  coverHash: text(),
  createdAt: integer().notNull(),
  committed: integer().notNull().default(0)
})

// R2 待删除文件的清理队列，只保存对象 key，不保存文件内容。
// 歌曲覆盖后的旧文件和过期上传的暂存文件进入队列，由每小时的定时任务清理。
// 删除前确认文件未被当前歌曲或未过期的待提交上传引用；R2 删除成功后才移除队列记录，失败则保留以便重试。
export const audioGarbage = sqliteTable('audioGarbage', {
  key: text().primaryKey()
})

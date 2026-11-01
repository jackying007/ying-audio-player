import { sql, type SQLWrapper } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const songNameSql = (filename: SQLWrapper) => sql<string>`substr(${filename}, 1, length(${filename}) - 4)`

export const folders = sqliteTable('folders', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique()
})

// 已发布的歌曲记录，供列表查询和播放使用；固定路径覆盖开始后暂停媒体读取，提交成功恢复。
export const audios = sqliteTable(
  'audios',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    folderId: integer()
      .notNull()
      .references(() => folders.id),
    filename: text().notNull(),
    metadata: text().notNull(),
    updating: integer().notNull().default(0),
    audioKey: text().notNull(),
    lyricsKey: text(),
    coverKey: text(),
    // 音频与歌词各自的 SHA-256；封面随音频更新，不单独保存 hash。
    hash: text().notNull(),
    lyricsHash: text()
  },
  table => [uniqueIndex('audioIndex').on(table.folderId, songNameSql(table.filename))]
)

// 单次上传的暂存记录，与 audios 暂时保存相似的元数据，但不作为歌曲列表使用。
// D1 和 R2 无法在同一个事务中提交，因此先暂存元数据并上传文件，
// 确认音频、歌词、封面全部上传成功后，再通过 D1 事务发布到 audios。
// 固定路径不保留历史文件；覆盖失败后歌曲保持 updating，下次同步强制重传。
// 已提交记录短期保留以支持幂等提交；超过 30 分钟的暂存记录由定时任务清理。
export const audioUploads = sqliteTable(
  'audioUploads',
  {
    id: text().primaryKey(),
    folderId: integer()
      .notNull()
      .references(() => folders.id),
    filename: text().notNull(),
    requiredFiles: text().notNull(),
    uploadedFiles: text().notNull().default('[]'),
    metadata: text().notNull(),
    // 保存本次发布使用的文件引用：未变化的文件复用已发布对象，变化的文件覆盖同一路径对象。
    audioKey: text(),
    lyricsKey: text(),
    coverKey: text(),
    hash: text().notNull(),
    lyricsHash: text(),
    createdAt: integer().notNull(),
    committed: integer().notNull().default(0)
  },
  table => [
    uniqueIndex('pendingSongUpload')
      .on(table.folderId, songNameSql(table.filename))
      .where(sql`${table.committed} = 0`)
  ]
)

// R2 待删除文件的清理队列，只保存对象 key，不保存文件内容。
// 歌曲覆盖后的旧文件和过期上传的暂存文件进入队列，由每小时的定时任务清理。
// 删除前确认文件未被当前歌曲或未过期的待提交上传引用；R2 删除成功后才移除队列记录，失败则保留以便重试。
export const audioGarbage = sqliteTable('audioGarbage', {
  key: text().primaryKey()
})

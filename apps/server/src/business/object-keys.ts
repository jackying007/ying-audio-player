import { sql, type SQLWrapper } from 'drizzle-orm'
import type { AudioMetadata } from './dto'
import { fileKinds, songName, type FileKind } from './metadata'

export const objectPrefix = (folder: string, filename: string) => folder + '/' + songName(filename)
export const objectKey = (prefix: string, kind: FileKind) => prefix + '/' + kind
export const hasFile = (metadata: AudioMetadata, kind: FileKind) =>
  kind === 'audio' || (kind === 'lyrics' ? metadata.hasLyrics : metadata.coverMime !== null)

export function objectKeys(row: { keyPrefix: string; metadata: string }) {
  const metadata = JSON.parse(row.metadata) as AudioMetadata
  return fileKinds.filter(kind => hasFile(metadata, kind)).map(kind => objectKey(row.keyPrefix, kind))
}

// Return NULL for undeclared files, just as the former nullable key columns did.
export function objectKeySql(row: { keyPrefix: SQLWrapper; metadata: SQLWrapper }, kind: FileKind) {
  const key = sql<string>`${row.keyPrefix} || ${'/' + kind}`
  if (kind === 'audio') return key
  const present =
    kind === 'lyrics'
      ? sql`json_extract(${row.metadata}, '$.hasLyrics') = 1`
      : sql`json_extract(${row.metadata}, '$.coverMime') IS NOT NULL`
  return sql<string | null>`CASE WHEN ${present} THEN ${key} ELSE NULL END`
}

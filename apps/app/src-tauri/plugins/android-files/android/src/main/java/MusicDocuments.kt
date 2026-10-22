package ying.audio.player.androidfiles

import java.io.File
import java.io.OutputStream

data class MusicDocument(val uri: String, val name: String, val size: Long?)

object MusicDocuments {
    fun songs(entries: List<MusicDocument>): List<Pair<MusicDocument, MusicDocument?>> {
        val names = entries.associateBy { it.name }
        return entries.filter { it.name.endsWith(".mp3", ignoreCase = true) }.map { song ->
            val stem = song.name.dropLast(4)
            song to (names[stem + ".lrc"] ?: entries.firstOrNull {
                it.name.endsWith(".lrc", ignoreCase = true) && it.name.dropLast(4) == stem
            })
        }
    }

    // The caller owns the successful temporary file; failures never leave a partial copy.
    fun copyTemporary(directory: File, copy: (OutputStream) -> Unit): File {
        val file = File.createTempFile("ying-audio-", ".mp3", directory)
        try {
            file.outputStream().use(copy)
            return file
        } catch (error: Exception) {
            file.delete()
            throw error
        }
    }
}

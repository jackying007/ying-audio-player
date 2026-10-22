package ying.audio.player.androidfiles

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class MusicDocumentsTest {
    @Test fun preservesNamesAndPairsOnlyDirectMp3AndLyrics() {
        val song = MusicDocument("content://opaque/1", "中文 原版.MP3", 12)
        val lyrics = MusicDocument("content://opaque/2", "中文 原版.LRC", 5)
        val songs = MusicDocuments.songs(listOf(song, lyrics, MusicDocument("ignored", "other.wav", 0)))
        assertEquals(listOf(song to lyrics), songs)
    }

    @Test fun failedCopyDeletesPartialFile() {
        val directory = Files.createTempDirectory("ying-test").toFile()
        try {
            try {
                MusicDocuments.copyTemporary(directory) { it.write(1); error("read failed") }
                fail("copy should fail")
            } catch (_: IllegalStateException) { }
            assertEquals(0, directory.listFiles()!!.size)
            val file = MusicDocuments.copyTemporary(directory) { it.write(byteArrayOf(0, -1, 42)) }
            assertArrayEquals(byteArrayOf(0, -1, 42), file.readBytes())
            file.delete()
        } finally { directory.delete() }
    }
}

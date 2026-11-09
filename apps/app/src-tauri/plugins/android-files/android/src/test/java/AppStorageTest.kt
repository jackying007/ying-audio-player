package ying.audio.player.androidfiles

import android.content.Context
import android.content.ContextWrapper
import android.os.Environment
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowEnvironment
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class AppStorageTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun context(files: File?): Context = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
        override fun getPackageName() = "ying.audio.player"
        override fun getExternalFilesDir(type: String?): File? = files?.apply { mkdirs() }
    }

    private fun files(packageName: String = "ying.audio.player") =
        File(temporary.root, "设备存储/Android/data/$packageName/files")

    @Test fun databaseAndCacheUseThePackageRootInsteadOfFilesOrInternalStorage() {
        val files = files()
        ShadowEnvironment.setExternalStorageState(files, Environment.MEDIA_MOUNTED)
        val root = AppStorage.root(context(files))
        File(root, "local-audio.sqlite3").writeBytes(byteArrayOf(0, -1, 42))
        File(root, "network-cache/音乐").mkdirs()
        File(root, "network-cache/音乐/原版.MP3").writeBytes(byteArrayOf(1, 2))
        assertEquals(files.parentFile, root)
        assertArrayEquals(byteArrayOf(0, -1, 42), File(files.parentFile, "local-audio.sqlite3").readBytes())
        assertTrue(File(files.parentFile, "network-cache/音乐/原版.MP3").isFile)
        assertFalse(File(files.parentFile, "network").exists())
        assertEquals(0, files.listFiles()!!.size)
    }

    @Test fun unavailableExternalStorageFailsWithoutUsingInternalStorage() {
        assertThrows(IllegalStateException::class.java) { AppStorage.root(context(null)) }
    }

    @Test fun readOnlyAndRemovedVolumesFailBeforeAnyDatabaseOrCacheIsWritten() {
        val files = files()
        for (state in listOf(Environment.MEDIA_MOUNTED_READ_ONLY, Environment.MEDIA_REMOVED)) {
            ShadowEnvironment.setExternalStorageState(files, state)
            assertThrows(IllegalStateException::class.java) { AppStorage.root(context(files)) }
            assertFalse(File(files.parentFile, "local-audio.sqlite3").exists())
            assertFalse(File(files.parentFile, "network-cache").exists())
        }
    }

    @Test fun aDirectoryForAnotherPackageIsRejected() {
        val files = files("other.package")
        ShadowEnvironment.setExternalStorageState(files, Environment.MEDIA_MOUNTED)
        assertThrows(IllegalStateException::class.java) { AppStorage.root(context(files)) }
    }
}

package ying.audio.player.androidfiles

import android.content.Context
import android.os.Environment
import java.io.File

object AppStorage {
    fun root(context: Context): File {
        // Ask Android to create this app's external directory before using its parent.
        // Keep the database and .network-cache directly under Android/data/<package>.
        val files = context.getExternalFilesDir(null) ?: error("应用外部存储不可用")
        check(Environment.getExternalStorageState(files) == Environment.MEDIA_MOUNTED) {
            "应用外部存储不可写，请检查设备存储状态"
        }
        val root = files.parentFile ?: error("无法获取应用外部数据目录")
        check(files.name == "files" && root.name == context.packageName) {
            "应用外部数据目录与当前包名不符"
        }
        check(root.isDirectory || root.mkdirs()) { "无法创建应用外部数据目录" }
        return root
    }
}

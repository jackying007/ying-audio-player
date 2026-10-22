package ying.audio.player.androidfiles

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

@InvokeArg
class UriArgs { lateinit var uri: String }

@TauriPlugin
class AndroidFilesPlugin(private val activity: Activity) : Plugin(activity) {
    private val resolver get() = activity.contentResolver
    private val worker = Executors.newSingleThreadExecutor()

    override fun onDestroy(activity: AppCompatActivity) { worker.shutdown() }

    private fun work(invoke: Invoke, block: () -> JSObject) {
        worker.execute {
            try {
                invoke.resolve(block())
            } catch (error: SecurityException) {
                invoke.reject("文件夹授权已失效，请重新导入原文件夹以恢复授权")
            } catch (error: Exception) {
                invoke.reject(error.message ?: "文件读取失败")
            }
        }
    }

    @Command
    fun storageRoot(invoke: Invoke) {
        worker.execute {
            try {
                invoke.resolve(JSObject().put("path", AppStorage.root(activity).absolutePath))
            } catch (error: Exception) {
                invoke.reject(error.message ?: "无法访问应用外部数据目录")
            }
        }
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(invoke, intent, "folderSelected")
    }

    @ActivityCallback
    fun folderSelected(invoke: Invoke, result: ActivityResult) {
        work(invoke) {
            val uri = FolderAccess.persistSelection(result.resultCode, result.data, resolver)
            JSObject().put("uri", uri?.toString() ?: JSONObject.NULL)
        }
    }

    @Command
    fun list(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        work(invoke) {
            val tree = Uri.parse(args.uri)
            FolderAccess.requireReadPermission(tree, resolver)
            val id = DocumentsContract.getTreeDocumentId(tree)
            val root = DocumentsContract.buildDocumentUriUsingTree(tree, id)
            val name = resolver.query(root, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    FolderAccess.requireCompleteListing(cursor.extras)
                    check(cursor.moveToFirst()) { "文件夹不存在" }
                    cursor.getString(0)
                } ?: error("无法读取文件夹")
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
            val entries = mutableListOf<MusicDocument>()
            resolver.query(children, arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE
            ), null, null, null)?.use { cursor ->
                FolderAccess.requireCompleteListing(cursor.extras)
                while (cursor.moveToNext()) {
                    if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) continue
                    entries.add(MusicDocument(
                        DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)).toString(),
                        cursor.getString(1),
                        if (cursor.isNull(3)) null else cursor.getLong(3)
                    ))
                }
            } ?: error("无法完整读取文件夹")
            val files = JSONArray()
            MusicDocuments.songs(entries).forEach { (song, lyrics) ->
                files.put(JSONObject().apply {
                    put("uri", song.uri)
                    put("name", song.name)
                    put("size", song.size ?: JSONObject.NULL)
                    put("lyricsUri", lyrics?.uri ?: JSONObject.NULL)
                })
            }
            JSObject().put("name", name).put("files", files)
        }
    }

    @Command
    fun materialize(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        work(invoke) {
            FolderAccess.requireReadPermission(Uri.parse(args.uri), resolver)
            val path = MusicDocuments.copyTemporary(activity.cacheDir) { output ->
                resolver.openInputStream(Uri.parse(args.uri))?.use { input -> input.copyTo(output) }
                    ?: error("文件不存在或无法读取")
            }
            JSObject().put("path", path.absolutePath)
        }
    }

    @Command
    fun release(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        work(invoke) {
            val uri = Uri.parse(args.uri)
            if (resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }) {
                resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            JSObject()
        }
    }
}

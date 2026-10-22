package ying.audio.player.androidfiles

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract

object FolderAccess {
    fun requireCompleteListing(extras: Bundle) {
        check(!extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) { "目录尚未加载完成，请稍后刷新" }
        val error = extras.getString(DocumentsContract.EXTRA_ERROR)
        check(error == null) { "无法完整读取文件夹：$error" }
    }

    fun persistSelection(resultCode: Int, data: Intent?, resolver: ContentResolver): Uri? {
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) return null
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return uri
    }

    fun requireReadPermission(uri: Uri, resolver: ContentResolver) {
        val treeId = DocumentsContract.getTreeDocumentId(uri)
        val allowed = resolver.persistedUriPermissions.any {
            it.isReadPermission && it.uri.authority == uri.authority &&
                DocumentsContract.getTreeDocumentId(it.uri) == treeId
        }
        if (!allowed) throw SecurityException("目录授权已失效")
    }
}

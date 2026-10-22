package ying.audio.player.androidfiles

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class FolderAccessTest {
    private val resolver get() = RuntimeEnvironment.getApplication().contentResolver
    private val tree = Uri.parse("content://music/tree/primary%3AMusic")

    @Test fun cancelledOrEmptySelectionDoesNotPersistPermission() {
        assertNull(FolderAccess.persistSelection(Activity.RESULT_CANCELED, Intent().setData(tree), resolver))
        assertNull(FolderAccess.persistSelection(Activity.RESULT_OK, null, resolver))
        assertTrue(resolver.persistedUriPermissions.isEmpty())
    }

    @Test fun selectionPersistsReadPermissionAndRevocationIsDetected() {
        assertEquals(tree, FolderAccess.persistSelection(Activity.RESULT_OK, Intent().setData(tree), resolver))
        val document = Uri.parse("content://music/tree/primary%3AMusic/document/opaque%3A123")
        FolderAccess.requireReadPermission(document, resolver)
        assertEquals(tree, resolver.persistedUriPermissions.single().uri)
        assertFalse(resolver.persistedUriPermissions.single().isWritePermission)
        resolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            FolderAccess.requireReadPermission(document, resolver)
            fail("revoked access must fail")
        } catch (_: SecurityException) { }
    }

    @Test fun incompleteAndFailedProviderListingsAreRejected() {
        FolderAccess.requireCompleteListing(Bundle.EMPTY)
        val loading = Bundle().apply { putBoolean(DocumentsContract.EXTRA_LOADING, true) }
        val failed = Bundle().apply { putString(DocumentsContract.EXTRA_ERROR, "provider unavailable") }
        for (extras in listOf(loading, failed)) {
            try {
                FolderAccess.requireCompleteListing(extras)
                fail("partial directories must not replace an existing index")
            } catch (_: IllegalStateException) { }
        }
    }
}

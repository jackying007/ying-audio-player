package ying.audio.player.androidfiles

import android.content.Intent
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import app.tauri.plugin.JSObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class PlaybackServiceTest {
    @Test
    fun removingTheTaskStopsTheServiceAndRemovesTheLoadingNotification() {
        val controller = Robolectric.buildService(PlaybackService::class.java).create()
        val service = controller.get()
        try {
            val begin = JSObject().put("kind", "begin").put("generation", 1)
                .put("payload", JSObject().put("title", "Song")
                    .put("controls", JSObject().put("next", true)))
            service.applyCommand(begin)
            val session = service.sessions.single()
            assertEquals(Player.STATE_BUFFERING, session.player.playbackState)
            assertEquals("Song", session.player.mediaMetadata.title)
            assertTrue(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT))
            assertFalse(session.player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS))
            service.applyCommand(JSObject().put("kind", "pause").put("generation", 1))
            assertFalse(session.player.playWhenReady)
            val shadow = shadowOf(service)
            assertEquals("Song", shadow.lastForegroundNotification.extras.getCharSequence("android.title"))

            service.onTaskRemoved(Intent())

            assertTrue(shadow.isStoppedBySelf)
            assertTrue(shadow.isForegroundStopped)
            assertTrue(shadow.notificationShouldRemoved)
            assertThrows(IllegalStateException::class.java) { service.applyCommand(begin.put("generation", 2)) }
        } finally {
            controller.destroy()
        }
        assertNull(PlaybackService.instance)
    }
}

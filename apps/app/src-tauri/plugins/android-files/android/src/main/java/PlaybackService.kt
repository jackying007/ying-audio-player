package ying.audio.player.androidfiles

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.io.File

@UnstableApi
class PlaybackService : MediaSessionService() {
    companion object {
        var instance: PlaybackService? = null
        var starting: Pair<Invoke, JSObject>? = null
        var events: Channel? = null

        private const val NOTIFICATION_ID = 109
        private const val CHANNEL_ID = "ying-playback"
    }

    private lateinit var player: ExoPlayer
    private lateinit var controls: SessionPlayer
    private lateinit var session: MediaSession
    private var generation = 0L
    private var hasSession = false
    private var preparing = false
    private var preparationPlayIntent = false
    private var exiting = false
    private var canPrevious = false
    private var canNext = false
    private var mediaTitle = ""
    private var artist: String? = null
    private var artwork: Uri? = null
    private var launchIntent: PendingIntent? = null
    private val handler = Handler(Looper.getMainLooper())
    private val progress = object : Runnable {
        override fun run() {
            if (player.isPlaying) status()
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        controls = SessionPlayer(player)
        launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        session = MediaSession.Builder(this, controls).apply {
            launchIntent?.let { setSessionActivity(it) }
        }.build()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this)
            .setNotificationId(NOTIFICATION_ID)
            .setChannelId(CHANNEL_ID)
            .build())
        addSession(session)
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (!currentItem()) return
                if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && player.playbackState == Player.STATE_ENDED) {
                    emit("ended")
                } else {
                    status()
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (currentItem()) emit("error")
            }
        })
        handler.post(progress)
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val result = super.onStartCommand(intent, flags, startId)
        starting?.let { (invoke, args) ->
            starting = null
            instance = this
            exiting = false
            engine(invoke, args)
            return START_NOT_STICKY
        }
        return result
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        exiting = true
        if (hasSession) emit("taskRemoved")
        clearSession()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (hasSession) emit("released")
        if (instance === this) instance = null
        handler.removeCallbacksAndMessages(null)
        session.release()
        player.release()
        super.onDestroy()
    }

    fun engine(invoke: Invoke, args: JSObject) {
        try {
            applyCommand(args)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法控制 Android 播放器")
        }
    }

    internal fun applyCommand(args: JSObject) {
        val incoming = args.getLong("generation")
        val kind = args.getString("kind")
        check(!exiting || kind == "stop")
        when (kind) {
            "begin" -> begin(incoming, args.getJSONObject("payload"))
            "stop" -> {
                generation = incoming
                clearSession()
            }
            "fail" -> {
                generation = incoming
                preparing = false
                player.stop()
                player.clearMediaItems()
                stopForeground(STOP_FOREGROUND_REMOVE)
            }
            else -> if (hasSession && incoming == generation) update(args)
        }
    }

    private fun begin(version: Long, payload: JSONObject) {
        generation = version
        hasSession = true
        preparing = true
        preparationPlayIntent = payload.optBoolean("autoplay", true)
        mediaTitle = payload.optString("title")
        artist = if (payload.isNull("artist")) null else payload.optString("artist")
        artwork = null
        showPreparingNotification()
        setControls(payload.getJSONObject("controls"))
        player.pause()
        player.clearMediaItems()
    }

    private fun showPreparingNotification() {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel(CHANNEL_ID, "音乐播放", NotificationManager.IMPORTANCE_LOW))
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        startForeground(NOTIFICATION_ID, builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(mediaTitle)
            .setContentText("正在加载音频")
            .setContentIntent(launchIntent)
            .setStyle(Notification.MediaStyle().setMediaSession(session.platformToken))
            .setOngoing(true)
            .build())
    }

    private fun update(args: JSObject) {
        when (args.getString("kind")) {
            "load" -> {
                val payload = args.getJSONObject("payload")
                val path = payload.getString("path")
                player.volume = payload.getDouble("volume").toFloat()
                player.setMediaItem(MediaItem.Builder()
                    .setMediaId(generation.toString())
                    .setUri(Uri.fromFile(File(path)))
                    .setMediaMetadata(metadata())
                    .build(), (payload.optDouble("position", 0.0) * 1000).toLong())
                player.playWhenReady = payload.getBoolean("autoplay")
                preparing = false
                player.prepare()
                status()
            }
            "pause", "resume" -> {
                val play = args.getString("kind") == "resume"
                if (preparing) {
                    preparationPlayIntent = play
                    controls.refresh()
                } else {
                    player.playWhenReady = play
                }
            }
            "seek" -> seek((args.getDouble("payload") * 1000).toLong())
            "volume" -> player.volume = args.getDouble("payload").toFloat()
            "controls" -> setControls(args.getJSONObject("payload"))
            "metadata" -> {
                val payload = args.getJSONObject("payload")
                mediaTitle = payload.optString("title")
                artist = if (payload.isNull("artist")) null else payload.optString("artist")
                updateMetadata()
            }
            "artwork" -> {
                val file = File(args.getString("payload"))
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.absolutePath, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    emit("artworkError")
                } else {
                    artwork = Uri.fromFile(file)
                    updateMetadata()
                }
            }
        }
    }

    private fun updateMetadata() {
        if (preparing) {
            controls.refresh()
        } else {
            player.currentMediaItem?.let {
                player.replaceMediaItem(player.currentMediaItemIndex, it.buildUpon().setMediaMetadata(metadata()).build())
            }
        }
    }

    private fun metadata() = MediaMetadata.Builder()
        .setTitle(mediaTitle)
        .setArtist(artist)
        .setArtworkUri(artwork)
        .build()

    private fun setControls(payload: JSONObject) {
        canPrevious = payload.optBoolean("previous")
        canNext = payload.optBoolean("next")
        controls.refresh()
    }

    private fun clearSession() {
        if (instance === this) instance = null
        hasSession = false
        preparing = false
        canPrevious = false
        canNext = false
        player.stop()
        player.clearMediaItems()
        controls.refresh()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun currentItem() = hasSession && player.currentMediaItem?.mediaId == generation.toString()

    private fun seek(positionMs: Long) {
        if (!currentItem() || !player.isCurrentMediaItemSeekable) return
        val end = if (player.duration == C.TIME_UNSET) Long.MAX_VALUE else player.duration
        player.seekTo(positionMs.coerceIn(0, end))
    }

    private fun emit(kind: String, fields: JSObject = JSObject()) {
        fields.put("kind", kind)
        fields.put("generation", generation)
        events?.send(fields)
    }

    private fun status() {
        if (!currentItem()) return
        emit("status", JSObject()
            .put("state", if (player.isPlaying) "playing" else "paused")
            .put("currentTime", player.currentPosition / 1000.0)
            .put("duration", if (player.duration == C.TIME_UNSET) JSONObject.NULL else player.duration / 1000.0)
            .put("buffering", player.playWhenReady && player.playbackState == Player.STATE_BUFFERING)
            .put("ready", player.playbackState == Player.STATE_READY))
    }

    private inner class SessionPlayer(player: Player) : ForwardingSimpleBasePlayer(player) {
        fun refresh() = invalidateState()

        override fun getState(): State {
            val state = super.getState()
            val commands = state.availableCommands.buildUpon()
                .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
                .remove(Player.COMMAND_SET_MEDIA_ITEM)
                .remove(Player.COMMAND_SET_REPEAT_MODE)
                .remove(Player.COMMAND_SET_SHUFFLE_MODE)
                .remove(Player.COMMAND_SEEK_BACK)
                .remove(Player.COMMAND_SEEK_FORWARD)
                .remove(Player.COMMAND_SEEK_TO_MEDIA_ITEM)
                .removeIf(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, preparing)
                .remove(Player.COMMAND_SEEK_TO_NEXT)
                .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
                .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                .addIf(Player.COMMAND_SEEK_TO_NEXT, canNext)
                .addIf(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, canNext)
                .addIf(Player.COMMAND_SEEK_TO_PREVIOUS, canPrevious)
                .addIf(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, canPrevious)
                .build()
            val builder = state.buildUpon().setAvailableCommands(commands)
            if (preparing) {
                val placeholder = MediaItemData.Builder("preparing-$generation")
                    .setMediaItem(MediaItem.Builder().setMediaId(generation.toString()).setMediaMetadata(metadata()).build())
                    .setMediaMetadata(metadata())
                    .build()
                builder.setPlaylist(listOf(placeholder))
                    .setCurrentMediaItemIndex(0)
                    .setPlaybackState(Player.STATE_BUFFERING)
                    .setPlayerError(null)
                    .setPlayWhenReady(preparationPlayIntent, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            }
            return builder.build()
        }

        override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
            if (hasSession) emit(if (playWhenReady) "resume" else "pause")
            return Futures.immediateVoidFuture()
        }

        override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
            when (seekCommand) {
                Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> emit("next")
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> emit("previous")
                Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM -> seek(positionMs)
            }
            return Futures.immediateVoidFuture()
        }

        override fun handleStop(): ListenableFuture<*> {
            if (hasSession) emit("stop")
            return Futures.immediateVoidFuture()
        }
    }
}

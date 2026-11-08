package ying.audio.player.androidfiles

import android.app.Activity
import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class PlaybackAttachArgs { lateinit var channel: Channel }

@TauriPlugin
class MobilePlaybackPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun attach(invoke: Invoke) {
        val channel = invoke.parseArgs(PlaybackAttachArgs::class.java).channel
        activity.runOnUiThread {
            PlaybackService.events = channel
            invoke.resolve()
        }
    }

    @Command
    fun engine(invoke: Invoke) {
        val args = invoke.getArgs()
        activity.runOnUiThread {
            val command = args.optString("kind")
            val service = PlaybackService.instance
            if (service != null) {
                service.engine(invoke, args)
            } else if (command == "begin") {
                val foreground = (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED)
                if (activity.isFinishing || activity.isDestroyed || foreground == false) {
                    invoke.reject("请在 App 内启动播放")
                    return@runOnUiThread
                }
                try {
                    PlaybackService.starting = invoke to args
                    activity.startForegroundServiceCompat(Intent(activity, PlaybackService::class.java))
                } catch (_: Exception) {
                    PlaybackService.starting = null
                    invoke.reject("无法启动后台播放服务")
                }
            } else {
                invoke.resolve()
            }
        }
    }

    private fun Activity.startForegroundServiceCompat(intent: Intent) {
        if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(intent)
        else startService(intent)
    }
}

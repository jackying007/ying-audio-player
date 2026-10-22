package ying.audio.player

import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import android.webkit.WebView
import android.webkit.WebSettings
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // The WebView uses the app's light theme independently of the system theme.
    // Transparent bars reveal the same background as the padded content below.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
      // Android 7 cannot draw dark navigation icons, so retain a readable fallback.
      navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.rgb(27, 27, 27))
    )
    super.onCreate(savedInstanceState)
    // Keep the WebView viewport, including fixed players and portals, inside system bars.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundResource(R.color.app_background)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(getColor(R.color.app_background))
    // Playback starts after asynchronous local reads or authenticated downloads.
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
  }
}

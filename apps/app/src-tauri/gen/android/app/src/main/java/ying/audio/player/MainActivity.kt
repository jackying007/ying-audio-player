package ying.audio.player

import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import android.webkit.WebView
import android.webkit.WebSettings
import android.webkit.JavascriptInterface
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  @Volatile private var topInsetCssPx = 0f

  inner class WindowInsetsBridge {
    @JavascriptInterface
    fun getTopInset(): Float = topInsetCssPx
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // The WebView uses the app's light theme independently of the system theme.
    // Keep system bars visible and transparent over the full-screen WebView.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
      // Android 7 cannot draw dark navigation icons, so retain a readable fallback.
      navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.rgb(27, 27, 27))
    )
    super.onCreate(savedInstanceState)
    // The header and sidebar handle the top safe area inside the WebView.
    // Keep native avoidance for side cutouts and the software keyboard.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundResource(R.color.app_background)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, 0, safe.right, safe.bottom)
      val top = insets.getInsets(WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()).top
      topInsetCssPx = top / resources.displayMetrics.density
      // CSS env() may remain zero in embedded WebViews. Publish the native
      // measurement directly, including updates after rotation/window changes.
      appWebView?.evaluateJavascript(
        "document.documentElement?.style.setProperty('--android-top-inset', '${topInsetCssPx}px')",
        null
      )
      // Forward system bars/cutouts for CSS env(safe-area-inset-top), but do not
      // let WebView resize for the keyboard a second time after native padding.
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    // The page reads the latest value on every load, even if insets arrived
    // before its document existed. This bridge exposes only a size getter.
    webView.addJavascriptInterface(WindowInsetsBridge(), "AndroidWindowInsets")
    webView.setBackgroundColor(getColor(R.color.app_background))
    // Playback starts after asynchronous local reads or authenticated downloads.
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
  }
}

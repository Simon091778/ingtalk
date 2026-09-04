package kr.ingtalk.notifications

import android.content.Intent
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/** Keep Expo's token handling, FCM acknowledgements and duplicate-delivery checks. */
class ChatFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun handleIntent(intent: Intent) {
    super.handleIntent(routeChatIntent(intent))
  }

  companion object {
    internal fun routeChatIntent(intent: Intent): Intent {
      val extras = intent.extras
      val data = try { JSONObject(extras?.getString("body") ?: "{}") } catch (_: Exception) { null }
      if (intent.action == "com.google.android.c2dm.intent.RECEIVE" &&
        data?.optString("kind") == "message" && !data.optString("room_id").isNullOrBlank()) {
        val routed = Intent(intent)
        // FCM normally bypasses Expo's presentation delegate when the app is closed.
        // Route ONLY chat messages through it, preserving the already-rendered preview
        // and channel. No server payload changes or background JS task are needed.
        fun copyField(target: String, vararg sources: String) {
          if (!routed.hasExtra(target)) {
            sources.firstNotNullOfOrNull { extras?.getString(it) }?.let { routed.putExtra(target, it) }
          }
        }
        copyField("title", "gcm.n.title", "gcm.notification.title")
        copyField("message", "gcm.n.body", "gcm.notification.body")
        copyField("channelId", "gcm.n.android_channel_id", "gcm.notification.android_channel_id")
        copyField("sound", "gcm.n.sound2", "gcm.n.sound", "gcm.notification.sound2", "gcm.notification.sound")
        // Do not intercept silent/data-only events without visible content.
        if (!routed.getStringExtra("title").isNullOrBlank() || !routed.getStringExtra("message").isNullOrBlank()) {
          routed.putExtra("gcm.n.e", "0")
          routed.putExtra("gcm.notification.e", "0")
          return routed
        }
      }
      return intent
    }
  }
}

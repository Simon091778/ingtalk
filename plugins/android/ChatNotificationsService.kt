package kr.ingtalk.notifications

import android.content.Context
import android.content.Intent
import expo.modules.notifications.notifications.model.NotificationResponse
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.interfaces.PresentationDelegate

class ChatNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate = ChatPresentationDelegate(context)

  override fun handleIntent(context: Context, intent: Intent) {
    if (intent.action == ChatPresentationDelegate.DELETE_ACTION) {
      intent.getStringExtra("tag")?.let { ChatPresentationDelegate(context).dismissNotifications(listOf(it)) }
    } else {
      super.handleIntent(context, intent)
    }
  }

  override fun onReceiveNotificationResponse(context: Context, intent: Intent) {
    super.onReceiveNotificationResponse(context, intent)
    val response = NotificationsService.getNotificationResponseFromBroadcastIntent(intent)
    val identifier = response.notification.notificationRequest.identifier
    if (response.action.identifier == NotificationResponse.DEFAULT_ACTION_IDENTIFIER &&
      identifier.startsWith(ChatPresentationDelegate.ROOM_PREFIX)) {
      // Android auto-cancels the tapped child; also update the cached count/summary.
      ChatPresentationDelegate(context).dismissNotifications(listOf(identifier))
    }
  }
}

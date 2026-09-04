package kr.ingtalk.notifications

import android.app.Notification as AndroidNotification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationAction
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.NotificationResponse
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

class ChatPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  companion object {
    const val ROOM_PREFIX = "ingtalk-chat-room:"
    const val SUMMARY_TAG = "ingtalk-chat-summary"
    const val DELETE_ACTION = "kr.ingtalk.notifications.DELETE"
    private const val GROUP = "kr.ingtalk.chat.messages"
    private const val COUNT = "ingtalk.messageCount"
    private const val LINES = "ingtalk.messageLines"
    private const val IDS = "ingtalk.messageIds"
    private val lock = Any()
    // The OS notification extras survive process death. This cache also serializes
    // bursts before NotificationManager.activeNotifications reflects the last post.
    private var restored = false
    private val rooms = linkedMapOf<String, AndroidNotification>()
  }

  private val manager get() = NotificationManagerCompat.from(context)
  private val systemManager get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun restore() {
    if (restored) return
    systemManager.activeNotifications.forEach {
      if (it.tag?.startsWith(ROOM_PREFIX) == true && it.notification.group == GROUP) rooms[it.tag] = it.notification
    }
    restored = true
  }

  override fun presentNotification(notification: Notification, behavior: NotificationBehaviorRecord?) {
    val request = notification.notificationRequest
    val data = request.content.body
    val roomId = data?.optString("room_id")
    if (data?.optString("kind") != "message" || roomId.isNullOrBlank() || behavior?.shouldPresentAlert == false) {
      super.presentNotification(notification, behavior)
      return
    }
    if (!manager.areNotificationsEnabled()) return
    // NotificationsService holds a goAsync() broadcast token on a worker thread.
    // Complete native posting before returning instead of launching detached work.
    synchronized(lock) {
      restore()
      val tag = ROOM_PREFIX + roomId
      val previous = rooms[tag]
      val messageId = data.optString("message_id").takeIf { it.isNotBlank() }
        ?: (request.trigger as? FirebaseNotificationTrigger)?.remoteMessage?.messageId
        ?: request.identifier
      val ids = ArrayList(previous?.extras?.getStringArrayList(IDS) ?: emptyList())
      if (ids.contains(messageId)) return
      ids.add(messageId)
      val count = (previous?.extras?.getInt(COUNT, 0) ?: 0) + 1
      val lines = ArrayList(previous?.extras?.getStringArrayList(LINES) ?: emptyList())
      lines.add(request.content.text ?: "새로운 메시지가 도착했어요.")
      val stable = Notification(NotificationRequest(tag, request.content, request.trigger), notification.originDate)
      val base = runBlocking { createNotification(stable, behavior) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        systemManager.getNotificationChannel(base.channelId)?.importance == NotificationManager.IMPORTANCE_NONE) return
      val inbox = NotificationCompat.InboxStyle().setBigContentTitle("잉톡")
      lines.takeLast(7).forEach { inbox.addLine(it) }
      val child = NotificationCompat.Builder(context, base)
        .setContentTitle("잉톡")
        .setGroup(GROUP)
        .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
        .setStyle(inbox)
        .setNumber(count)
        .setSubText("메시지 ${count}개")
        .setDeleteIntent(deleteIntent(tag))
        .addExtras(Bundle().apply {
          putInt(COUNT, count)
          putStringArrayList(LINES, ArrayList(lines.takeLast(7)))
          putStringArrayList(IDS, ArrayList(ids.takeLast(100)))
        }).build()
      rooms.remove(tag)
      rooms[tag] = child
      manager.notify(tag, 0, child)
      updateSummary()
    }
  }

  private fun deleteIntent(tag: String): PendingIntent {
    val intent = Intent(context, ChatNotificationsService::class.java)
      .setAction(DELETE_ACTION)
      .setData(Uri.parse("ingtalk-notification://delete").buildUpon().appendPath(tag).build())
      .putExtra("tag", tag)
    return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun updateSummary() {
    if (rooms.isEmpty()) {
      manager.cancel(SUMMARY_TAG, 0)
      return
    }
    val latest = rooms.values.last()
    val count = rooms.values.sumOf { it.extras.getInt(COUNT, 1) }
    val title = "메시지 ${count}개"
    val summaryEvent = Notification(NotificationRequest(
      SUMMARY_TAG,
      NotificationContent.Builder().setTitle("잉톡").setText(title)
        .setBody(JSONObject().put("kind", "message")).build(),
      null,
    ))
    val open = NotificationsService.createNotificationResponseIntent(context, summaryEvent,
      NotificationAction(NotificationResponse.DEFAULT_ACTION_IDENTIFIER, null, true))
    val inbox = NotificationCompat.InboxStyle().setBigContentTitle("잉톡")
    rooms.values.toList().takeLast(7).forEach { item ->
      inbox.addLine("${item.extras.getInt(COUNT, 1)}개 · ${NotificationCompat.getContentText(item) ?: "새 메시지"}")
    }
    val summary = NotificationCompat.Builder(context, latest)
      .setContentTitle("잉톡")
      .setContentText(title)
      .setSubText("대화 ${rooms.size}개")
      .setStyle(inbox)
      .setNumber(count)
      .setGroup(GROUP)
      .setGroupSummary(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setAutoCancel(false)
      .setContentIntent(open)
      .setDeleteIntent(deleteIntent(SUMMARY_TAG))
      .build()
    manager.notify(SUMMARY_TAG, 0, summary)
  }

  override fun getAllPresentedNotifications(): Collection<Notification> =
    systemManager.activeNotifications.filter { it.tag != SUMMARY_TAG }.mapNotNull { getNotification(it) }

  override fun dismissNotifications(identifiers: Collection<String>) {
    synchronized(lock) {
      restore()
      if (identifiers.contains(SUMMARY_TAG)) {
        rooms.keys.toList().forEach { manager.cancel(it, 0) }
        rooms.clear()
      } else {
        identifiers.forEach { rooms.remove(it) }
      }
      super.dismissNotifications(identifiers)
      updateSummary()
    }
  }

  override fun dismissAllNotifications() {
    synchronized(lock) {
      rooms.clear()
      restored = true
      super.dismissAllNotifications()
    }
  }
}

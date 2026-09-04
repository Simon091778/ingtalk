package kr.ingtalk.notifications

import android.app.Application
import android.app.Notification as AndroidNotification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class ChatPresentationDelegateTest {
  private lateinit var context: Context
  private lateinit var delegate: ChatPresentationDelegate
  private lateinit var manager: NotificationManager

  @Before fun setup() {
    context = ApplicationProvider.getApplicationContext()
    manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    delegate = ChatPresentationDelegate(context)
    delegate.dismissAllNotifications()
  }

  private fun message(room: String, id: String) = Notification(NotificationRequest(id,
    NotificationContent.Builder().setTitle("새 메시지").setText("본문 $id")
      .setBody(JSONObject().put("kind", "message").put("room_id", room)).build(), null))

  private fun summary() = manager.activeNotifications.single { it.tag == ChatPresentationDelegate.SUMMARY_TAG }.notification

  @Test fun routesVisibleChatThroughExpoWithoutMutatingTheOriginalFcmIntent() {
    val original = Intent("com.google.android.c2dm.intent.RECEIVE")
      .putExtra("body", "{\"kind\":\"message\",\"room_id\":\"a\"}")
      .putExtra("gcm.n.e", "1").putExtra("gcm.n.title", "새 메시지")
      .putExtra("gcm.n.body", "본문").putExtra("gcm.n.android_channel_id", "silent-chat")
      .putExtra("google.message_id", "unique-message")
    val routed = ChatFirebaseMessagingService.routeChatIntent(original)
    assertNotSame(original, routed)
    assertEquals("1", original.getStringExtra("gcm.n.e"))
    assertEquals("0", routed.getStringExtra("gcm.n.e"))
    assertEquals("새 메시지", routed.getStringExtra("title"))
    assertEquals("본문", routed.getStringExtra("message"))
    assertEquals("silent-chat", routed.getStringExtra("channelId"))
    assertEquals("unique-message", routed.getStringExtra("google.message_id"))
  }

  @Test fun leavesRequestsSilentPayloadsAndTokenEventsOnTheOriginalPath() {
    val request = Intent("com.google.android.c2dm.intent.RECEIVE")
      .putExtra("body", "{\"kind\":\"chat_request\",\"room_id\":\"a\"}")
      .putExtra("gcm.n.e", "1").putExtra("gcm.n.title", "대화 신청")
    val silent = Intent("com.google.android.c2dm.intent.RECEIVE")
      .putExtra("body", "{\"kind\":\"message\",\"room_id\":\"a\"}")
    val token = Intent("com.google.firebase.messaging.NEW_TOKEN").putExtra("token", "test-token")
    listOf(request, silent, token).forEach { assertSame(it, ChatFirebaseMessagingService.routeChatIntent(it)) }
  }

  @Test fun threeMessagesBecomeOneRoomAndOneSilentSummary() {
    (1..3).forEach { delegate.presentNotification(message("a", "$it"), null) }
    assertEquals(2, manager.activeNotifications.size)
    val child = manager.activeNotifications.single { it.tag == ChatPresentationDelegate.ROOM_PREFIX + "a" }.notification
    assertEquals(3, child.number)
    assertEquals("잉톡", child.extras.getCharSequence(AndroidNotification.EXTRA_TITLE)?.toString())
    assertEquals("잉톡", child.extras.getCharSequence(AndroidNotification.EXTRA_TITLE_BIG)?.toString())
    assertEquals("본문 3", child.extras.getCharSequence(AndroidNotification.EXTRA_TEXT)?.toString())
    assertEquals(listOf("본문 1", "본문 2", "본문 3"),
      child.extras.getCharSequenceArray(AndroidNotification.EXTRA_TEXT_LINES)?.map { it.toString() })
    assertEquals(3, summary().number)
    assertEquals("잉톡", summary().extras.getCharSequence(AndroidNotification.EXTRA_TITLE)?.toString())
    assertEquals("잉톡", summary().extras.getCharSequence(AndroidNotification.EXTRA_TITLE_BIG)?.toString())
    assertEquals(child.group, summary().group)
    assertTrue(summary().flags and AndroidNotification.FLAG_GROUP_SUMMARY != 0)
    assertNull(summary().sound)
    assertEquals(1, delegate.getAllPresentedNotifications().size)
  }

  @Test fun duplicateDeliveryDoesNotIncreaseCount() {
    repeat(3) { delegate.presentNotification(message("a", "same-id"), null) }
    assertEquals(1, summary().number)
  }

  @Test fun distinctFcmMessagesWithTheSameNotificationTagStillAccumulate() {
    (1..3).forEach { index ->
      val content = message("a", "$index").notificationRequest.content
      val remote = RemoteMessage.Builder("test-recipient").setMessageId("fcm-$index").build()
      val notification = Notification(NotificationRequest("reused-tag", content, FirebaseNotificationTrigger(remote)))
      delegate.presentNotification(notification, null)
    }
    assertEquals(3, summary().number)
  }

  @Test fun clearingOneRoomPreservesTheOtherAndUpdatesSummary() {
    delegate.presentNotification(message("a", "1"), null)
    delegate.presentNotification(message("a", "2"), null)
    delegate.presentNotification(message("b", "3"), null)
    assertEquals(3, manager.activeNotifications.size)
    assertEquals(3, summary().number)
    delegate.dismissNotifications(listOf(ChatPresentationDelegate.ROOM_PREFIX + "a"))
    assertEquals(2, manager.activeNotifications.size)
    assertEquals(1, summary().number)
    delegate.dismissNotifications(listOf(ChatPresentationDelegate.ROOM_PREFIX + "b"))
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test fun swipingSummaryClearsAllGroupedRooms() {
    delegate.presentNotification(message("a", "1"), null)
    delegate.presentNotification(message("b", "2"), null)
    ChatNotificationsService().handleIntent(context, Intent(ChatPresentationDelegate.DELETE_ACTION)
      .putExtra("tag", ChatPresentationDelegate.SUMMARY_TAG))
    assertTrue(manager.activeNotifications.isEmpty())
    delegate.presentNotification(message("a", "3"), null)
    assertEquals(1, summary().number)
  }

  @Test fun hiddenForegroundNotificationDoesNotEnterTheGroup() {
    delegate.presentNotification(message("a", "1"), NotificationBehaviorRecord())
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test fun reconstructsAccumulatedCountFromOsNotificationsAfterProcessRestart() {
    delegate.presentNotification(message("a", "1"), null)
    // Simulate process-local state loss without removing system notifications.
    ChatPresentationDelegate::class.java.getDeclaredField("rooms").apply { isAccessible = true }
      .get(null).let { (it as MutableMap<*, *>).clear() }
    ChatPresentationDelegate::class.java.getDeclaredField("restored").apply { isAccessible = true }.setBoolean(null, false)
    ChatPresentationDelegate(context).presentNotification(message("a", "2"), null)
    assertEquals(2, summary().number)
  }
}

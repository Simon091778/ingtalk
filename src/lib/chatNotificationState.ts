import { AppState, Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'

let activeRoomId: string | null = null

export function setActiveChatNotificationRoom(roomId: string | null) {
  activeRoomId = roomId
}

export function shouldSuppressChatNotification(data: Record<string, unknown> | undefined) {
  return Platform.OS === 'android' && AppState.currentState === 'active' &&
    activeRoomId !== null && data?.kind === 'message' && data.room_id === activeRoomId
}

export async function dismissReadChatNotifications(roomId: string) {
  if (Platform.OS !== 'android' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return
  try {
    const Notifications: typeof import('expo-notifications') = require('expo-notifications')
    const notifications = await Notifications.getPresentedNotificationsAsync()
    const identifiers = new Set([`ingtalk-chat-room:${roomId}`, ...notifications
      .filter(item => item.request.content.data?.kind === 'message' && item.request.content.data.room_id === roomId)
      .map(item => item.request.identifier)])
    await Promise.all([...identifiers].map(identifier => Notifications.dismissNotificationAsync(identifier)))
  } catch (error) {
    // Notification housekeeping must not interrupt reading or sending messages.
    console.warn('읽은 대화 알림을 정리하지 못했습니다.', error)
  }
}

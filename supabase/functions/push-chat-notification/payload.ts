export type PushRecord = {
  id: number
  user_id: string
  title: string
  body: string
  data: Record<string, string | number>
}

type PushToken = { token: string; platform: 'ios' | 'android' }
type DisplayPreferences = {
  sound_enabled?: boolean | null
  vibration_enabled?: boolean | null
  preview_enabled?: boolean | null
}
type DeliveryPreferences = DisplayPreferences & {
  message_enabled?: boolean | null
  open_chat_enabled?: boolean | null
  request_enabled?: boolean | null
}

export type ChatPushKind = 'chat_request' | 'message' | 'open_chat_message'

const DEFAULT_NOTIFICATION_SOUND = 'ingtalk_default_alarm.wav'
const DEFAULT_NOTIFICATION_CHANNEL = 'messages-v3'
const SOUND_ONLY_NOTIFICATION_CHANNEL = 'messages-sound-v3'

export function getChatPushKind(record: PushRecord): ChatPushKind {
  const kind = record.data?.kind
  return kind === 'chat_request' ? 'chat_request' : kind === 'open_chat_message' ? 'open_chat_message' : 'message'
}

export function getDisabledNotificationCategory(record: PushRecord, preferences: DeliveryPreferences | null) {
  const kind = getChatPushKind(record)
  if (kind === 'message' && preferences?.message_enabled === false) return 'message'
  if (kind === 'open_chat_message' && preferences?.open_chat_enabled === false) return 'open_chat'
  if (kind === 'chat_request' && preferences?.request_enabled === false) return 'request'
  return null
}

// Keep this pure so platform-specific APNs/FCM payloads can be tested without sending pushes.
export function createChatPushMessage(token: PushToken, record: PushRecord, preferences: DisplayPreferences | null) {
  const kind = getChatPushKind(record)
  const soundEnabled = preferences?.sound_enabled !== false
  const vibrationEnabled = preferences?.vibration_enabled !== false
  const previewEnabled = preferences?.preview_enabled !== false
  const channelId = soundEnabled ? (vibrationEnabled ? DEFAULT_NOTIFICATION_CHANNEL : SOUND_ONLY_NOTIFICATION_CHANNEL) : (vibrationEnabled ? 'messages-vibrate' : 'messages-silent')
  const roomId = kind === 'open_chat_message' ? record.data?.open_chat_room_id : record.data?.room_id
  const notificationGroup = kind === 'open_chat_message' && roomId ? `open-chat-${roomId}` : kind === 'message' && roomId ? `chat-${roomId}` : 'chat-requests'
  const isIosMessage = token.platform === 'ios' && kind === 'message'
  const isIosOpenChatMessage = token.platform === 'ios' && kind === 'open_chat_message'

  return {
    to: token.token,
    sound: soundEnabled ? DEFAULT_NOTIFICATION_SOUND : null,
    channelId,
    title: kind === 'chat_request' ? '새 대화 신청' : kind === 'open_chat_message' ? '수다방' : '잉톡',
    body: previewEnabled
      ? (kind === 'chat_request' ? '새로운 대화 신청이 도착했어요.' : record.body)
      : (kind === 'chat_request' ? '새로운 대화 신청이 도착했어요.' : kind === 'open_chat_message' ? '수다방에 새 메시지가 도착했어요.' : '새로운 메시지가 도착했어요.'),
    data: kind === 'open_chat_message' ? { kind, open_chat_room_id: roomId } : { kind, room_id: roomId },
    priority: 'high',
    // On iOS collapseId replaces displayed notifications, losing the earlier messages.
    // Preserve Android's existing in-transit collapsing and the chat-request behavior.
    ...(isIosMessage || isIosOpenChatMessage ? {} : { collapseId: notificationGroup }),
    // All iPhone chat messages share one stack, even when sent from different rooms.
    // room_id remains in data for the existing notification tap handling.
    threadId: isIosMessage ? 'ingtalk-chat-messages' : isIosOpenChatMessage ? 'ingtalk-open-chat-messages' : notificationGroup,
  }
}

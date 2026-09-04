import { getAccountId } from './phoneAuth'
import { Platform } from 'react-native'
import { supabase } from './supabase'

export const DEFAULT_NOTIFICATION_SOUND = 'ingtalk_default_alarm.wav'
export const DEFAULT_NOTIFICATION_CHANNEL = 'messages-v3'
export const SOUND_ONLY_NOTIFICATION_CHANNEL = 'messages-sound-v3'

export type NotificationPreferences = {
  message_enabled: boolean
  open_chat_enabled: boolean
  request_enabled: boolean
  preview_enabled: boolean
  sound_enabled: boolean
  vibration_enabled: boolean
}

export const defaultNotificationPreferences: NotificationPreferences = {
  message_enabled: true,
  open_chat_enabled: true,
  request_enabled: true,
  preview_enabled: true,
  sound_enabled: true,
  vibration_enabled: true,
}

export async function configureNotificationChannels(preferences = defaultNotificationPreferences) {
  if (Platform.OS !== 'android') return
  const Notifications = await import('expo-notifications')
  const channels = [
    { id: DEFAULT_NOTIFICATION_CHANNEL, name: '대화 알림 · 소리와 진동', importance: Notifications.AndroidImportance.HIGH, sound: DEFAULT_NOTIFICATION_SOUND, enableVibrate: true, vibrationPattern: [0, 250, 180, 250] },
    { id: SOUND_ONLY_NOTIFICATION_CHANNEL, name: '대화 알림 · 소리', importance: Notifications.AndroidImportance.HIGH, sound: DEFAULT_NOTIFICATION_SOUND, enableVibrate: false, vibrationPattern: [0] },
    { id: 'messages-vibrate', name: '대화 알림 · 진동', importance: Notifications.AndroidImportance.HIGH, sound: null, enableVibrate: true, vibrationPattern: [0, 250, 180, 250] },
    { id: 'messages-silent', name: '대화 알림 · 무음', importance: Notifications.AndroidImportance.DEFAULT, sound: null, enableVibrate: false, vibrationPattern: [0] },
  ]
  await Promise.all(channels.map(channel => Notifications.setNotificationChannelAsync(channel.id, channel)))
}

export async function loadNotificationPreferences() {
  if (!supabase) return defaultNotificationPreferences
  const userId = await getAccountId(supabase)
  if (!userId) return defaultNotificationPreferences
  const { data, error } = await supabase.from('notification_preferences').select('message_enabled, open_chat_enabled, request_enabled, preview_enabled, sound_enabled, vibration_enabled').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return { ...defaultNotificationPreferences, ...(data ?? {}) } as NotificationPreferences
}

export async function saveNotificationPreferences(preferences: NotificationPreferences) {
  if (!supabase) return
  const userId = await getAccountId(supabase)
  if (!userId) throw new Error('로그인 정보를 확인할 수 없습니다.')
  const { error } = await supabase.from('notification_preferences').upsert({ user_id: userId, ...preferences, updated_at: new Date().toISOString() })
  if (error) throw error
  await configureNotificationChannels(preferences)
}

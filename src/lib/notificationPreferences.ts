import { Platform } from 'react-native'
import { supabase } from './supabase'

export type NotificationPreferences = {
  message_enabled: boolean
  request_enabled: boolean
  preview_enabled: boolean
  sound_enabled: boolean
  vibration_enabled: boolean
}

export const defaultNotificationPreferences: NotificationPreferences = {
  message_enabled: true,
  request_enabled: true,
  preview_enabled: true,
  sound_enabled: true,
  vibration_enabled: true,
}

export async function configureNotificationChannels(preferences = defaultNotificationPreferences) {
  if (Platform.OS !== 'android') return
  const Notifications = await import('expo-notifications')
  const channels = [
    { id: 'messages', name: '대화 알림 · 소리와 진동', importance: Notifications.AndroidImportance.HIGH, sound: 'default' as const, enableVibrate: true, vibrationPattern: [0, 250, 180, 250] },
    { id: 'messages-sound', name: '대화 알림 · 소리', importance: Notifications.AndroidImportance.HIGH, sound: 'default' as const, enableVibrate: false, vibrationPattern: [0] },
    { id: 'messages-vibrate', name: '대화 알림 · 진동', importance: Notifications.AndroidImportance.HIGH, sound: null, enableVibrate: true, vibrationPattern: [0, 250, 180, 250] },
    { id: 'messages-silent', name: '대화 알림 · 무음', importance: Notifications.AndroidImportance.DEFAULT, sound: null, enableVibrate: false, vibrationPattern: [0] },
  ]
  await Promise.all(channels.map(channel => Notifications.setNotificationChannelAsync(channel.id, channel)))
}

export async function loadNotificationPreferences() {
  if (!supabase) return defaultNotificationPreferences
  const { data: session } = await supabase.auth.getSession()
  const userId = session.session?.user.id
  if (!userId) return defaultNotificationPreferences
  const { data, error } = await supabase.from('notification_preferences').select('message_enabled, request_enabled, preview_enabled, sound_enabled, vibration_enabled').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return { ...defaultNotificationPreferences, ...(data ?? {}) } as NotificationPreferences
}

export async function saveNotificationPreferences(preferences: NotificationPreferences) {
  if (!supabase) return
  const { data: session } = await supabase.auth.getSession()
  const userId = session.session?.user.id
  if (!userId) throw new Error('로그인 정보를 확인할 수 없습니다.')
  const { error } = await supabase.from('notification_preferences').upsert({ user_id: userId, ...preferences, updated_at: new Date().toISOString() })
  if (error) throw error
  await configureNotificationChannels(preferences)
}

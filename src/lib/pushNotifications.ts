import { useEffect } from 'react'
import { Alert, Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { supabase } from './supabase'
import { captureAppError } from './observability'
import { configureNotificationChannels, loadNotificationPreferences } from './notificationPreferences'

function isAndroidExpoGo() {
  return Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
}

function getProjectId() {
  return Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId
}

export function useChatPushNotifications(enabled: boolean, openChats: () => void) {
  useEffect(() => {
    if (!enabled || !supabase || Platform.OS === 'web' || isAndroidExpoGo()) return
    const client = supabase
    let active = true
    let receivedSubscription: { remove: () => void } | undefined
    let responseSubscription: { remove: () => void } | undefined

    const setup = async () => {
      const Notifications = await import('expo-notifications')
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: true,
          shouldSetBadge: true,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      })

      if (Platform.OS === 'android') {
        await configureNotificationChannels(await loadNotificationPreferences())
      }

      const current = await Notifications.getPermissionsAsync()
      const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync()
      if (permission.status !== 'granted') return

      const projectId = getProjectId()
      if (!projectId) {
        console.warn('Expo 프로젝트 ID가 없어 푸시 토큰을 등록하지 못했습니다. eas init을 실행해 주세요.')
        return
      }

      const { data: sessionData } = await client.auth.getSession()
      const userId = sessionData.session?.user.id
      if (!userId) return

      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
      const { error } = await client.from('push_tokens').upsert({
        user_id: userId,
        token,
        platform: Platform.OS,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,token' })
      if (error && !error.message.includes('push_tokens')) throw error

      if (!active) return
      receivedSubscription = Notifications.addNotificationReceivedListener(() => undefined)
      responseSubscription = Notifications.addNotificationResponseReceivedListener(response => {
        const kind = response.notification.request.content.data?.kind
        if (kind === 'chat_request' || kind === 'message') openChats()
      })

      const lastResponse = await Notifications.getLastNotificationResponseAsync()
      const lastKind = lastResponse?.notification.request.content.data?.kind
      if (lastKind === 'chat_request' || lastKind === 'message') openChats()
    }

    void setup().catch(reason => {
      const message = reason instanceof Error ? reason.message : String(reason)
      captureAppError(reason, 'push_notifications', 'register_token', { platform: Platform.OS })
      if (!message.includes('push_tokens')) Alert.alert('알림 설정 오류', message)
    })

    return () => {
      active = false
      receivedSubscription?.remove()
      responseSubscription?.remove()
    }
  }, [enabled, openChats])
}

import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as Location from 'expo-location'
import { Platform } from 'react-native'
import type { PermissionPreferences } from '../components/ConsentGate'
import { configureNotificationChannels } from './notificationPreferences'

export async function requestConsentPermissions(permissions: PermissionPreferences) {
  if (permissions.location) await Location.requestForegroundPermissionsAsync()
  if (!permissions.notifications) return

  const isAndroidExpoGo = Platform.OS === 'android'
    && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  if (isAndroidExpoGo) return

  const Notifications = await import('expo-notifications')
  if (Platform.OS === 'android') {
    await configureNotificationChannels()
  }
  await Notifications.requestPermissionsAsync()
}

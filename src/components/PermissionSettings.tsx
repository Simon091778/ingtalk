import { useCallback, useEffect, useState } from 'react'
import { AppState, Linking, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, View } from 'react-native'
import { Text } from '../i18n/localizedUi'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as Location from 'expo-location'
import { SwipeDismissView } from './SwipeDismissView'
import { NotificationSettings } from './NotificationSettings'

type PermissionKey = 'location' | 'notifications'
type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable'

const permissionNames: Record<PermissionKey, string> = {
  location: '위치', notifications: '알림',
}
const permissionKeys = Object.keys(permissionNames) as PermissionKey[]
const initialStates = Object.fromEntries(permissionKeys.map(key => [key, 'undetermined'])) as Record<PermissionKey, PermissionState>

function normalizeStatus(status: string): PermissionState {
  if (status === 'granted') return 'granted'
  if (status === 'denied') return 'denied'
  return 'undetermined'
}

function isAndroidExpoGo() {
  return Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
}

async function readNotificationStatus(): Promise<PermissionState> {
  if (isAndroidExpoGo()) return 'unavailable'
  const Notifications = await import('expo-notifications')
  return normalizeStatus((await Notifications.getPermissionsAsync()).status)
}

export function PermissionSettings() {
  const insets = useSafeAreaInsets()
  const [states, setStates] = useState(initialStates)
  const [requesting, setRequesting] = useState<PermissionKey | null>(null)
  const [visible, setVisible] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)
  const [notificationSettingsVisible, setNotificationSettingsVisible] = useState(false)
  const [openNotificationsAfterDismiss, setOpenNotificationsAfterDismiss] = useState(false)

  const refresh = useCallback(async () => {
    const [location, notifications] = await Promise.all([
      Location.getForegroundPermissionsAsync().then(result => normalizeStatus(result.status)),
      readNotificationStatus().catch(() => 'unavailable' as const),
    ])
    setStates({ location, notifications })
  }, [])

  useEffect(() => {
    void refresh()
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh()
    })
    return () => subscription.remove()
  }, [refresh])

  const requestPermission = async (key: PermissionKey) => {
    if (requesting) return
    if (states[key] === 'denied') {
      await Linking.openSettings()
      return
    }
    setRequesting(key)
    try {
      if (key === 'location') await Location.requestForegroundPermissionsAsync()
      if (key === 'notifications') {
        if (isAndroidExpoGo()) {
          await Linking.openSettings()
        } else {
          const Notifications = await import('expo-notifications')
          if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('messages', {
              name: '대화 및 메시지', importance: Notifications.AndroidImportance.HIGH,
            })
          }
          await Notifications.requestPermissionsAsync()
        }
      }
      await refresh()
    } finally {
      setRequesting(null)
    }
  }

  const grantedCount = permissionKeys.filter(key => states[key] === 'granted').length
  const modalTopInset = Math.max(insets.top, Platform.OS === 'ios' ? 50 : (StatusBar.currentHeight ?? 24))
  const openNotificationSettings = () => {
    if (Platform.OS === 'ios') {
      // iOS does not reliably present a second full-screen modal over an active
      // React Native modal. Dismiss the parent first, then present notifications.
      setOpenNotificationsAfterDismiss(true)
      setVisible(false)
      return
    }
    setNotificationSettingsVisible(true)
  }
  const finishPermissionModalDismiss = () => {
    if (!openNotificationsAfterDismiss) return
    setOpenNotificationsAfterDismiss(false)
    setNotificationSettingsVisible(true)
  }
  const finishNotificationModalDismiss = () => {
    if (Platform.OS === 'ios') {
      setClosingBySwipe(false)
      setVisible(true)
      void refresh()
    }
  }

  return <>
    <Pressable style={styles.menuCard} onPress={() => { setClosingBySwipe(false); setVisible(true); void refresh() }}>
      <View style={styles.menuIcon}><Text style={styles.menuIconText}>⚙</Text></View>
      <View style={styles.menuBody}><Text style={styles.menuTitle}>권한 설정</Text><Text style={styles.menuDescription}>위치, 사진, 알림 등 기기 권한 관리 · {grantedCount}/{permissionKeys.length} 허용</Text></View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>

    <Modal visible={visible} animationType={Platform.OS === 'android' ? 'fade' : closingBySwipe ? 'none' : 'slide'} statusBarTranslucent={false} onDismiss={finishPermissionModalDismiss} onRequestClose={() => setVisible(false)}>
      <SwipeDismissView onDismissStart={() => setClosingBySwipe(true)} onDismiss={() => setVisible(false)}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={[styles.modalTopArea, { paddingTop: modalTopInset }] }>
          <View style={styles.modalHeader}>
            <Pressable style={[styles.headerButton, styles.headerButtonLeft]} onPress={() => setVisible(false)} hitSlop={10}><Text style={styles.close}>닫기</Text></Pressable>
            <Text pointerEvents="none" style={styles.modalTitle}>권한 설정</Text>
            <Pressable style={[styles.headerButton, styles.headerButtonRight]} onPress={() => void Linking.openSettings()} hitSlop={6}><Text style={styles.settingsLink}>기기 설정</Text></Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          <Text style={styles.description}>거리 표시와 사진·알림 기능에 필요한 권한을 관리합니다.</Text>
          <View style={styles.card}>
            {permissionKeys.map(key => {
              const status = states[key]
              const granted = status === 'granted'
              const label = requesting === key ? '확인 중' : granted ? '허용됨' : status === 'denied' ? '설정에서 허용' : status === 'unavailable' ? '기기 설정' : '허용하기'
              const rowContent = <>
                <View style={[styles.dot, granted && styles.dotGranted]} /><View style={styles.permissionName}><Text style={styles.name}>{permissionNames[key]}</Text>{key === 'notifications' && <Text style={styles.detailChevron}>›</Text>}</View>
                <Pressable disabled={granted || requesting !== null} onPress={() => void requestPermission(key)} style={[styles.button, granted && styles.buttonGranted, requesting !== null && !granted && styles.buttonDisabled]}><Text style={[styles.buttonText, granted && styles.buttonTextGranted]}>{label}</Text></Pressable>
              </>
              return key === 'notifications'
                ? <Pressable accessibilityRole="button" accessibilityLabel="알림 세부 설정" key={key} onPress={openNotificationSettings} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>{rowContent}</Pressable>
                : <View key={key} style={styles.row}>{rowContent}</View>
            })}
          </View>
          {isAndroidExpoGo() && <Text style={styles.note}>Android Expo Go에서는 알림 권한 확인이 제한됩니다. 실제 개발 빌드에서는 정상적으로 설정할 수 있습니다.</Text>}
        </ScrollView>
      </SafeAreaView>
      </SwipeDismissView>
    </Modal>
    <NotificationSettings visible={notificationSettingsVisible} onClose={() => setNotificationSettingsVisible(false)} onDismiss={finishNotificationModalDismiss} />
  </>
}

const styles = StyleSheet.create({
  menuCard: { minHeight: 74, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 16, marginTop: 14, borderWidth: 1, borderColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center' },
  menuIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#FFF0E9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  menuIconText: { color: '#F26B4B', fontSize: 20, fontWeight: '800' }, menuBody: { flex: 1 },
  menuTitle: { color: '#374151', fontSize: 15, fontWeight: '900' }, menuDescription: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 4 },
  chevron: { color: '#A8A29E', fontSize: 27, marginLeft: 8, marginBottom: 3 },
  modalSafe: { flex: 1, backgroundColor: '#FFF9F5' }, modalTopArea: { backgroundColor: '#FFF9F5', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' }, modalHeader: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', position: 'relative' },
  modalTitle: { position: 'absolute', left: 86, right: 86, textAlign: 'center', color: '#1F2937', fontSize: 16, fontWeight: '900' },
  headerButton: { minWidth: 86, height: 56, justifyContent: 'center', zIndex: 2 }, headerButtonLeft: { alignItems: 'flex-start', paddingLeft: 18 }, headerButtonRight: { alignItems: 'flex-end', paddingRight: 18 },
  close: { color: '#F26B4B', fontSize: 15, fontWeight: '900' },
  modalContent: { padding: 20, paddingBottom: 36 }, card: { backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 16, marginTop: 14, borderWidth: 1, borderColor: '#F0EAE6' },
  description: { color: '#78716C', fontSize: 12, lineHeight: 18 },
  settingsLink: { color: '#F26B4B', fontSize: 12, fontWeight: '800' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#F3EEEA' },
  rowPressed: { backgroundColor: '#FFF8F4' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#D1D5DB', marginRight: 9 }, dotGranted: { backgroundColor: '#22C55E' },
  permissionName: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center' }, name: { color: '#374151', fontSize: 13, fontWeight: '700' }, detailChevron: { color: '#A8A29E', fontSize: 22, marginLeft: 7, marginBottom: 2 },
  button: { minWidth: 82, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, alignItems: 'center', backgroundColor: '#FFF0E9' },
  buttonGranted: { backgroundColor: '#ECFDF5' }, buttonDisabled: { opacity: 0.55 },
  buttonText: { color: '#E85D3B', fontSize: 11, fontWeight: '800' }, buttonTextGranted: { color: '#15803D' },
  note: { color: '#9A3412', backgroundColor: '#FFF7ED', borderRadius: 10, padding: 10, fontSize: 10, lineHeight: 15, marginTop: 8 },
})

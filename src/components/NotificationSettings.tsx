import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../i18n/localizedUi'
import { defaultNotificationPreferences, loadNotificationPreferences, saveNotificationPreferences, type NotificationPreferences } from '../lib/notificationPreferences'
import { SwipeDismissView } from './SwipeDismissView'

const options: Array<{ key: keyof NotificationPreferences; title: string; description: string }> = [
  { key: 'message_enabled', title: '메시지 알림', description: '새 메시지가 도착하면 알려드려요.' },
  { key: 'open_chat_enabled', title: '수다방 알림', description: '참여 중인 수다방의 새 메시지를 알려드려요.' },
  { key: 'request_enabled', title: '대화 신청 알림', description: '새로운 대화 신청을 알려드려요.' },
  { key: 'preview_enabled', title: '메시지 내용 미리보기', description: '알림에 메시지 내용을 표시합니다.' },
  { key: 'sound_enabled', title: '소리', description: '알림이 올 때 소리를 재생합니다.' },
  { key: 'vibration_enabled', title: '진동', description: '알림이 올 때 기기를 진동시킵니다.' },
]

export function NotificationSettings({ visible, onClose, onDismiss }: { visible: boolean; onClose: () => void; onDismiss?: () => void }) {
  const insets = useSafeAreaInsets()
  const [preferences, setPreferences] = useState(defaultNotificationPreferences)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)

  useEffect(() => {
    if (!visible) return
    setClosingBySwipe(false)
    setLoading(true)
    void loadNotificationPreferences().then(setPreferences).catch(error => Alert.alert('알림 설정 오류', error instanceof Error ? error.message : String(error))).finally(() => setLoading(false))
  }, [visible])

  const toggle = async (key: keyof NotificationPreferences) => {
    if (saving) return
    const next = { ...preferences, [key]: !preferences[key] }
    setPreferences(next)
    setSaving(true)
    try { await saveNotificationPreferences(next) }
    catch (error) { setPreferences(preferences); Alert.alert('저장 실패', error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }

  const topInset = Math.max(insets.top, Platform.OS === 'ios' ? 47 : 0)

  return <Modal visible={visible} animationType="none" onDismiss={onDismiss} onRequestClose={onClose}>
    <SwipeDismissView visible={visible} onDismissStart={() => setClosingBySwipe(true)} onDismiss={onClose}>
    <SafeAreaView style={[styles.safe, { paddingTop: topInset }]} edges={['bottom']}>
      <View style={styles.header}><Pressable onPress={onClose} hitSlop={10} style={styles.headerButton}><Text style={styles.close}>‹ 권한 설정</Text></Pressable><Text pointerEvents="none" style={styles.title}>알림</Text><View style={styles.headerButton} /></View>
      {loading ? <View style={styles.center}><ActivityIndicator color="#F26B4B" /></View> : <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>받고 싶은 알림과 알림 방식을 선택하세요.</Text>
        <View style={styles.card}>{options.map((option, index) => <View key={option.key} style={[styles.row, index > 0 && styles.divider]}><View style={styles.copy}><Text style={styles.optionTitle}>{option.title}</Text><Text style={styles.description}>{option.description}</Text></View><Switch accessibilityLabel={option.title} accessibilityState={{ checked: preferences[option.key] }} value={preferences[option.key]} onValueChange={() => void toggle(option.key)} trackColor={{ false: '#C9CDD2', true: '#F26B4B' }} thumbColor={preferences[option.key] ? '#FFFFFF' : '#F5F5F4'} ios_backgroundColor="#C9CDD2" /></View>)}</View>
        <Text style={styles.note}>같은 대화방의 연속 메시지는 하나의 알림 묶음으로 정리됩니다. 기기 자체 알림 설정이 꺼져 있으면 이 설정과 관계없이 알림이 표시되지 않습니다.</Text>
      </ScrollView>}
    </SafeAreaView>
    </SwipeDismissView>
  </Modal>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, header: { height: 58, borderBottomWidth: 1, borderBottomColor: '#EEE7E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerButton: { width: 104, height: 58, justifyContent: 'center', paddingHorizontal: 16 }, close: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, title: { position: 'absolute', left: 104, right: 104, textAlign: 'center', fontSize: 17, fontWeight: '900', color: '#292524' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, content: { padding: 20, paddingBottom: 40 }, intro: { color: '#78716C', fontSize: 12, lineHeight: 18 }, card: { marginTop: 14, borderRadius: 16, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6' }, row: { minHeight: 72, flexDirection: 'row', alignItems: 'center' }, divider: { borderTopWidth: 1, borderTopColor: '#F3EEEA' }, copy: { flex: 1, paddingRight: 14 }, optionTitle: { color: '#292524', fontSize: 14, fontWeight: '800' }, description: { color: '#8A817C', fontSize: 10, lineHeight: 15, marginTop: 4 }, note: { marginTop: 14, color: '#78716C', fontSize: 10, lineHeight: 16, paddingHorizontal: 4 },
})

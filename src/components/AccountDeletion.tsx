import { useState } from 'react'
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Text, TextInput } from '../i18n/localizedUi'
import { useI18n } from '../i18n'
import { supabase } from '../lib/supabase'
import { captureAppError, identifyAnonymousUser } from '../lib/observability'
import { SwipeDismissView } from './SwipeDismissView'

const CONFIRMATION = '탈퇴합니다'

async function deletionErrorMessage(reason: unknown, language: 'ko' | 'en') {
  const fallback = language === 'en'
    ? 'Account deletion failed. Please try again shortly.'
    : '회원 탈퇴를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
  if (!reason || typeof reason !== 'object') return fallback
  const context = 'context' in reason ? reason.context : null
  if (context instanceof Response) {
    const payload = await context.clone().json().catch(() => null) as { error?: string } | null
    if (payload?.error === 'invalid_session' || context.status === 401) {
      return language === 'en'
        ? 'Your session has expired. Restart the app, then try again.'
        : '로그인 세션이 만료되었습니다. 앱을 다시 실행한 후 시도해 주세요.'
    }
  }
  return fallback
}

export function AccountDeletion({ onDeleted }: { onDeleted: () => void }) {
  const { language } = useI18n()
  const confirmationPhrase = language === 'en' ? 'DELETE' : CONFIRMATION
  const [visible, setVisible] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)

  const close = () => { if (!deleting) { setVisible(false); setConfirmation('') } }
  const removeLocalData = () => {
    try {
      localStorage.removeItem('ingtalk.guest-profile.v1')
      localStorage.removeItem('ingtalk.consent.v2')
      localStorage.removeItem('ingtalk.consent.v3')
      localStorage.removeItem('ingtalk.consent.v4')
      localStorage.removeItem('ingtalk.last-sent-request-message.v1')
      localStorage.removeItem('ingtalk.last-published-talk-card.v1')
    } catch { /* Native storage may not expose localStorage in every runtime. */ }
  }
  const deleteAccount = async () => {
    if (confirmation.trim() !== confirmationPhrase || deleting) return
    setDeleting(true)
    try {
      if (supabase) {
        const { data: sessionData } = await supabase.auth.getSession()
        if (!sessionData.session) throw new Error('현재 로그인 정보를 확인하지 못했습니다. 앱을 다시 실행한 후 시도해 주세요.')
        const { data, error } = await supabase.functions.invoke('delete-account', { body: { confirmation: true } })
        if (error) throw error
        if (!data?.deleted) throw new Error(data?.error ?? '계정 삭제가 완료되지 않았습니다.')
        await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
      }
      removeLocalData()
      identifyAnonymousUser(null)
      setVisible(false)
      onDeleted()
      Alert.alert('회원 탈퇴 완료', '계정과 서비스 데이터가 삭제되었습니다.')
    } catch (reason) {
      captureAppError(reason, 'account', 'delete')
      const message = await deletionErrorMessage(reason, language)
      Alert.alert(language === 'en' ? 'Account deletion failed' : '회원 탈퇴 실패', message)
    } finally {
      setDeleting(false)
    }
  }

  return <>
    <View style={styles.card}>
      <View style={styles.cardText}><Text style={styles.title}>회원 탈퇴</Text><Text style={styles.description}>계정과 작성한 콘텐츠를 영구 삭제합니다</Text></View>
      <Pressable accessibilityRole="button" onPress={() => setVisible(true)} style={styles.openButton}><Text style={styles.openButtonText}>탈퇴</Text></Pressable>
    </View>
    <Modal visible={visible} animationType="none" presentationStyle="fullScreen" onRequestClose={close}>
      <SwipeDismissView visible={visible} onDismiss={close} enabled={!deleting}>
      <KeyboardAvoidingView testID="account-deletion-keyboard-viewport" style={styles.flex} enabled behavior="padding">
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}><Pressable disabled={deleting} hitSlop={12} onPress={close} style={styles.headerButton}><Text style={styles.close}>취소</Text></Pressable><Text style={styles.headerTitle}>회원 탈퇴</Text><View style={styles.headerButton} /></View>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          <View style={styles.warning}><Text style={styles.warningTitle}>탈퇴하면 복구할 수 없습니다</Text><Text style={styles.warningText}>{language === 'en' ? 'This deletes the entire account shared across all phones and linked sign-in methods. Other phones lose access too. Deleted points and chats cannot be restored. Registration on all registered devices is restricted for 7 days.' : '모든 휴대폰과 연결된 로그인 수단이 함께 사용하는 계정 전체를 삭제합니다. 다른 휴대폰도 로그아웃되며, 삭제된 포인트와 대화는 복구되지 않습니다. 등록된 기기에서는 7일 동안 다시 가입할 수 없습니다.'}</Text></View>
          <Text style={styles.sectionTitle}>삭제되는 정보</Text>
          <View style={styles.list}><Text>• 프로필, 사진 및 위치</Text><Text>• 톡쓰기, 게시글, 댓글 및 첨부 사진</Text><Text>• 대화 신청, 채팅방 및 메시지</Text><Text>• 포인트, 출석과 활동 보상 내역</Text><Text>• 차단 정보, 알림과 기기 푸시 토큰</Text></View>
          <Text style={styles.retention}>신고 처리와 서비스 악용 방지를 위해 보존이 필요한 최소 운영 기록은 이용자 식별정보와 작성 내용을 제거한 후 제한적으로 남을 수 있습니다.</Text>
          <Text style={styles.confirmLabel}>{language === 'en' ? `Type “${confirmationPhrase}” below to confirm` : `확인을 위해 아래에 “${confirmationPhrase}”를 입력해 주세요`}</Text>
          <TextInput value={confirmation} onChangeText={setConfirmation} editable={!deleting} autoCapitalize="none" autoCorrect={false} placeholder={confirmationPhrase} style={styles.input} returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()} />
          <Pressable disabled={confirmation.trim() !== confirmationPhrase || deleting} onPress={() => void deleteAccount()} style={[styles.deleteButton, (confirmation.trim() !== confirmationPhrase || deleting) && styles.disabled]}>{deleting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.deleteButtonText}>계정과 데이터 영구 삭제</Text>}</Pressable>
        </ScrollView>
      </SafeAreaView>
      </KeyboardAvoidingView>
      </SwipeDismissView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { minHeight: 68, marginTop: 14, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: '#F1D3D8', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' },
  cardText: { flex: 1, marginRight: 12 }, title: { color: '#7F1D1D', fontSize: 14, fontWeight: '900' }, description: { color: '#9F6B6B', fontSize: 10, marginTop: 4 },
  openButton: { minWidth: 58, minHeight: 38, borderRadius: 10, borderWidth: 1, borderColor: '#F3B8C1', alignItems: 'center', justifyContent: 'center' }, openButtonText: { color: '#BE2948', fontSize: 11, fontWeight: '900' },
  safe: { flex: 1, backgroundColor: '#FFF9F8' }, header: { height: 58, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#EEE4E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerButton: { width: 76, minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' }, close: { color: '#D94F70', fontSize: 15, fontWeight: '900' }, headerTitle: { color: '#292524', fontSize: 17, fontWeight: '900' },
  content: { padding: 20, paddingBottom: 45 }, warning: { padding: 17, borderRadius: 16, backgroundColor: '#FFF0F2', borderWidth: 1, borderColor: '#F8CBD3' }, warningTitle: { color: '#9F1239', fontSize: 16, fontWeight: '900' }, warningText: { color: '#9F5667', fontSize: 12, lineHeight: 19, marginTop: 7 },
  sectionTitle: { color: '#292524', fontSize: 14, fontWeight: '900', marginTop: 25, marginBottom: 10 }, list: { gap: 8, padding: 15, borderRadius: 14, backgroundColor: '#FFFFFF' }, retention: { color: '#78716C', fontSize: 11, lineHeight: 18, marginTop: 14 }, confirmLabel: { color: '#44403C', fontSize: 12, fontWeight: '800', marginTop: 27, marginBottom: 9 }, input: { minHeight: 48, borderWidth: 1, borderColor: '#D6D3D1', borderRadius: 13, backgroundColor: '#FFFFFF', paddingHorizontal: 14, color: '#292524', fontSize: 15 },
  deleteButton: { minHeight: 52, borderRadius: 14, backgroundColor: '#BE2948', alignItems: 'center', justifyContent: 'center', marginTop: 14 }, deleteButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, disabled: { opacity: 0.35 },
})

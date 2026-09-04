import { useEffect, useState } from 'react'
import { BackHandler, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '../i18n/localizedUi'
import { SafeAreaView } from 'react-native-safe-area-context'
import { PRIVACY_POLICY_TEXT, TERMS_OF_SERVICE_TEXT } from '../content/legal'
import { PRIVACY_POLICY_TEXT_EN, TERMS_OF_SERVICE_TEXT_EN } from '../content/legal.en'
import { requestConsentPermissions } from '../lib/consentPermissions'
import { SwipeDismissView } from './SwipeDismissView'
import { AppStartupScreen } from './AppStartupScreen'

export type PermissionPreferences = {
  location: boolean
  notifications: boolean
}

const CONSENT_KEY = 'ingtalk.consent.v4'
const initialPermissions: PermissionPreferences = {
  location: true,
  notifications: true,
}

type AgreementKey = 'adult' | 'terms' | 'privacy'
type DetailKey = AgreementKey | keyof PermissionPreferences

const details: Record<DetailKey, { title: string; body: string }> = {
  adult: {
    title: '성인 이용 확인',
    body: '잉톡은 만 19세 이상만 이용할 수 있습니다. 동의하면 본인이 만 19세 이상이며 정확한 나이를 입력한다는 점을 확인합니다. 나이를 허위로 입력하거나 미성년자의 이용이 확인되면 계정과 콘텐츠가 제한 또는 삭제될 수 있습니다.',
  },
  terms: {
    title: '서비스 이용약관',
    body: TERMS_OF_SERVICE_TEXT,
  },
  privacy: {
    title: '개인정보 처리방침',
    body: PRIVACY_POLICY_TEXT,
  },
  location: {
    title: '위치 권한',
    body: '가까운 지역의 대화 상대를 추천하기 위해 앱을 사용하는 동안의 위치를 사용합니다. 정확한 좌표를 다른 사용자에게 공개하지 않으며, 동의하지 않으면 지역을 직접 선택할 수 있습니다.',
  },
  notifications: {
    title: '알림 권한',
    body: '새로운 대화 요청, 메시지, 신고 처리 결과와 중요한 서비스 안내를 기기에 알림으로 보내기 위해 사용합니다. 동의하지 않아도 앱을 열어 직접 확인할 수 있으며 기본 기능 이용에는 제한이 없습니다.',
  },
}

function Check({ checked }: { checked: boolean }) {
  return <View style={[styles.check, checked && styles.checkActive]}><Text style={styles.checkMark}>{checked ? '✓' : ''}</Text></View>
}

export function ConsentGate({ onComplete, onBack, language = 'ko' }: { onComplete: (permissions: PermissionPreferences) => void; onBack?: () => void; language?: 'ko' | 'en' }) {
  const [loading, setLoading] = useState(true)
  const [agreements, setAgreements] = useState<Record<AgreementKey, boolean>>({ adult: true, terms: true, privacy: true })
  const [permissions, setPermissions] = useState(initialPermissions)
  const [detail, setDetail] = useState<DetailKey | null>(null)
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CONSENT_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as { permissions: PermissionPreferences }
        onComplete({ ...initialPermissions, ...parsed.permissions })
        return
      }
    } catch {
      localStorage.removeItem(CONSENT_KEY)
    }
    setLoading(false)
  }, [onComplete])

  useEffect(() => {
    if (!onBack) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail) setDetail(null)
      else onBack()
      return true
    })
    return () => subscription.remove()
  }, [detail, onBack])

  if (loading) return <AppStartupScreen language={language} />

  const requiredComplete = agreements.adult && agreements.terms && agreements.privacy
  const allSelected = requiredComplete && Object.values(permissions).every(Boolean)

  const toggleAll = () => {
    const next = !allSelected
    setAgreements({ adult: next, terms: next, privacy: next })
    setPermissions({ location: next, notifications: next })
  }

  const finish = async () => {
    if (!requiredComplete || requesting) return
    setRequesting(true)
    try {
      // 선택한 항목만 운영체제 권한을 요청하며, 거부해도 앱 이용은 제한하지 않습니다.
      await requestConsentPermissions(permissions)

      const acceptedAt = new Date().toISOString()
      localStorage.setItem(CONSENT_KEY, JSON.stringify({ acceptedAt, adultConfirmedAt: acceptedAt, permissions }))
      onComplete(permissions)
    } finally {
      setRequesting(false)
    }
  }

  const rows: Array<{ key: DetailKey; required: boolean; label: string }> = [
    { key: 'adult', required: true, label: '본인은 만 19세 이상입니다' },
    { key: 'terms', required: true, label: '서비스 이용약관 동의' },
    { key: 'privacy', required: true, label: '개인정보 처리방침 확인' },
    { key: 'location', required: false, label: '위치 접근 권한' },
    { key: 'notifications', required: false, label: '알림 수신 권한' },
  ]

  const isAgreement = (key: DetailKey): key is AgreementKey => key === 'adult' || key === 'terms' || key === 'privacy'
  const isChecked = (key: DetailKey) => isAgreement(key) ? agreements[key] : permissions[key]
  const toggle = (key: DetailKey) => {
    if (isAgreement(key)) setAgreements(value => ({ ...value, [key]: !value[key] }))
    else setPermissions(value => ({ ...value, [key]: !value[key] }))
  }

  const content = <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        {onBack ? <Pressable accessibilityRole="button" accessibilityLabel={language === 'ko' ? '언어 및 국가 선택으로 돌아가기' : 'Back to language and country'} hitSlop={10} onPress={onBack} style={styles.backButton}><Text style={styles.backText}>‹ {language === 'ko' ? '이전' : 'Back'}</Text></Pressable> : <View style={styles.backButton} />}
        <Text style={styles.logo}>잉톡</Text>
        <View style={styles.backButton} />
      </View>

      <Pressable style={styles.allRow} onPress={toggleAll}>
        <Check checked={allSelected} />
        <Text style={styles.allLabel}>모두 동의합니다</Text>
      </Pressable>

      <View style={styles.card}>
        {rows.map((row, index) => <View key={row.key} style={[styles.row, index > 0 && styles.divider]}>
          <Pressable style={styles.rowMain} onPress={() => toggle(row.key)}>
            <Check checked={isChecked(row.key)} />
            <Text style={styles.badge}>{row.required ? '[필수]' : '[선택]'}</Text>
            <Text style={styles.label}>{row.label}</Text>
          </Pressable>
          <Pressable hitSlop={12} onPress={() => setDetail(row.key)}><Text style={styles.more}>›</Text></Pressable>
        </View>)}
      </View>

    </ScrollView>
    <View style={styles.footer}>
      <Pressable disabled={!requiredComplete || requesting} onPress={finish} style={[styles.button, (!requiredComplete || requesting) && styles.buttonDisabled]}>
        <Text style={styles.buttonText}>{requesting ? '권한 확인 중…' : '동의하고 시작하기'}</Text>
      </Pressable>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>권한은 언제든 변경할 수 있어요</Text>
        <Text style={styles.noticeText}>내 정보의 권한 설정 또는 기기 설정에서 변경할 수 있습니다.</Text>
      </View>
    </View>

    <Modal visible={detail !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setDetail(null)}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}><Text style={styles.modalTitle}>{detail ? details[detail].title : ''}</Text><Pressable onPress={() => setDetail(null)}><Text style={styles.close}>닫기</Text></Pressable></View>
        <ScrollView contentContainerStyle={styles.modalBody}><Text style={styles.detailText}>{detail === 'terms' && language === 'en' ? TERMS_OF_SERVICE_TEXT_EN : detail === 'privacy' && language === 'en' ? PRIVACY_POLICY_TEXT_EN : detail ? details[detail].body : ''}</Text></ScrollView>
      </SafeAreaView>
    </Modal>
  </SafeAreaView>
  return onBack
    ? <SwipeDismissView enabled={detail === null} onDismiss={onBack}>{content}</SwipeDismissView>
    : content
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, loading: { flex: 1, backgroundColor: '#FFF9F5', alignItems: 'center', justifyContent: 'center' }, brand: { color: '#F26B4B', fontSize: 30, fontWeight: '900' },
  container: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 12 }, topRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }, backButton: { width: 82, minHeight: 44, justifyContent: 'center' }, backText: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, logo: { color: '#F26B4B', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  allRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF0E9', borderRadius: 16, paddingHorizontal: 15, paddingVertical: 14 }, allLabel: { color: '#9A3412', fontSize: 16, fontWeight: '800', marginLeft: 11 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: '#EEE7E2', paddingHorizontal: 15, marginTop: 11 }, row: { minHeight: 49, flexDirection: 'row', alignItems: 'center' }, divider: { borderTopWidth: 1, borderTopColor: '#F3EEEA' }, rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 49 },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: '#D6D3D1', alignItems: 'center', justifyContent: 'center' }, checkActive: { backgroundColor: '#F26B4B', borderColor: '#F26B4B' }, checkMark: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, badge: { color: '#A8A29E', fontSize: 11, marginLeft: 10, marginRight: 6 }, label: { flex: 1, color: '#44403C', fontSize: 13, fontWeight: '600' }, more: { color: '#A8A29E', fontSize: 27, paddingHorizontal: 5 },
  footer: { backgroundColor: '#FFF9F5', paddingHorizontal: 22, paddingTop: 10, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#F3EEEA' },
  notice: { alignItems: 'center', marginTop: 9 }, noticeTitle: { color: '#6D5C85', fontWeight: '800', fontSize: 11 }, noticeText: { color: '#8B7FA0', fontSize: 10, lineHeight: 15, marginTop: 2, textAlign: 'center' },
  button: { backgroundColor: '#F26B4B', borderRadius: 16, paddingVertical: 15, alignItems: 'center' }, buttonDisabled: { opacity: 0.35 }, buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  modalSafe: { flex: 1, backgroundColor: '#FFFFFF' }, modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: '#EEE7E2' }, modalTitle: { color: '#1F2937', fontSize: 18, fontWeight: '900' }, close: { color: '#F26B4B', fontWeight: '800' }, modalBody: { padding: 22 }, detailText: { color: '#44403C', fontSize: 14, lineHeight: 23 },
})

import { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Text } from '../i18n/localizedUi'
import { supabase } from '../lib/supabase'
import { SwipeDismissView } from './SwipeDismissView'
import { formatDateTime, formatNumber, useI18n } from '../i18n'

type PointTransaction = {
  id: number
  amount: number
  reason: string
  created_at: string
}

const reasonLabels: Record<string, string> = {
  welcome_device: '최초 지급',
  reward_attendance: '출석체크',
  reward_talk_write: '톡쓰기 등록',
  reward_board_post: '익명 게시글 작성',
  reward_board_comment: '익명 댓글 작성',
  reward_rewarded_ad: '광고 시청 보상',
  chat_request: '대화 신청',
  open_chat_room_create: '수다방 만들기',
  profile_details_update: '프로필 정보 수정',
  point_purchase: '포인트 충전',
  point_purchase_refund: '포인트 구매 환불',
  admin_adjustment: '운영자 포인트 조정',
}

export function PointDetails({ visible, balance, attendanceAvailable, claimingAttendance, onClose, onCharge, onAttendance, embeddedIos = false }: {
  visible: boolean
  balance: number | null
  attendanceAvailable: boolean | null
  claimingAttendance: boolean
  onClose: () => void
  onCharge: () => void
  onAttendance: () => Promise<void>
  embeddedIos?: boolean
}) {
  const i18n = useI18n()
  const [transactions, setTransactions] = useState<PointTransaction[]>([])
  const [loading, setLoading] = useState(false)
  const [historyVisible, setHistoryVisible] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)

  useEffect(() => { if (visible) setClosingBySwipe(false) }, [visible])

  const loadTransactions = useCallback(async () => {
    if (!supabase) { setTransactions([]); return }
    setLoading(true)
    const { data, error } = await supabase
      .from('point_transactions')
      .select('id, amount, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
    if (!error) setTransactions((data ?? []).map(item => ({ ...item, amount: Number(item.amount) })) as PointTransaction[])
    setLoading(false)
  }, [])

  useEffect(() => { if (historyVisible) void loadTransactions() }, [historyVisible, balance, loadTransactions])

  const attendance = async () => {
    await onAttendance()
  }

  const closeDetails = () => {
    setHistoryVisible(false)
    onClose()
  }

  const details = <>
    <SwipeDismissView visible={visible} onDismissStart={() => { if (!historyVisible) setClosingBySwipe(true) }} onDismiss={historyVisible ? () => setHistoryVisible(false) : closeDetails}>
    <SafeAreaView edges={embeddedIos ? ['bottom'] : ['top', 'bottom']} style={styles.safe}>
      {historyVisible ? <>
        <View style={styles.header}><Pressable onPress={() => setHistoryVisible(false)} style={styles.headerButton}><Text style={styles.close}>이전</Text></Pressable><Text style={styles.title}>포인트 내역</Text><View style={styles.headerButton} /></View>
        <ScrollView contentContainerStyle={styles.historyContent}>
          <View style={styles.historyCard}>
            {loading ? <Text style={styles.empty}>내역을 불러오고 있어요.</Text> : transactions.length === 0 ? <Text style={styles.empty}>아직 포인트 내역이 없습니다.</Text> : transactions.map((item, index) => <View key={item.id} style={[styles.transaction, index > 0 && styles.transactionBorder]}><View style={styles.transactionBody}><Text style={styles.reason}>{reasonLabels[item.reason] ?? '포인트 변경'}</Text><Text style={styles.date}>{formatDateTime(item.created_at, i18n.language, i18n.country, true)}</Text></View><Text style={[styles.amount, item.amount > 0 ? styles.earned : styles.spent]}>{item.amount > 0 ? '+' : ''}{formatNumber(item.amount, i18n.language, i18n.country)}P</Text></View>)}
          </View>
        </ScrollView>
      </> : <>
        <View style={styles.header}><Pressable onPress={closeDetails} style={styles.headerButton}><Text style={styles.close}>닫기</Text></Pressable><Text style={styles.title}>포인트 상세</Text><View style={styles.headerButton} /></View>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.balanceCard}><Text style={styles.balanceLabel}>현재 포인트</Text><Text style={styles.balance}>{balance == null ? '—' : `${formatNumber(balance, i18n.language, i18n.country)}P`}</Text></View>
          <Text style={styles.rewardPolicy}>{i18n.language === 'ko' ? '50P 활동 보상은 항목별로 계정과 기기당 24시간에 한 번 지급됩니다. 계정을 바꿔도 같은 기기의 수령 이력은 유지됩니다.' : 'Each 50P activity reward is available once per 24 hours per account and device. Switching accounts does not reset the device cooldown.'}</Text>
          <Pressable onPress={onCharge} style={styles.chargeButton}><Text style={styles.chargeText}>충전하기</Text><Text style={styles.arrow}>›</Text></Pressable>
          <Pressable disabled={attendanceAvailable !== true || claimingAttendance} onPress={() => void attendance()} style={[styles.attendanceButton, (attendanceAvailable !== true || claimingAttendance) && styles.disabled]}><Text style={styles.attendanceText}>{claimingAttendance ? '출석 확인 중…' : attendanceAvailable === null ? '출석 상태 확인 중…' : attendanceAvailable ? '출석체크 · +50P' : '출석체크 완료 · 24시간 후 가능'}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="포인트 내역 상세 보기" onPress={() => setHistoryVisible(true)} style={styles.historyButton}><View><Text style={styles.historyButtonTitle}>포인트 내역 보기</Text><Text style={styles.historyButtonDescription}>적립 및 사용 내역을 확인해요</Text></View><Text style={styles.arrow}>›</Text></Pressable>
        </ScrollView>
      </>}
    </SafeAreaView>
    </SwipeDismissView>
  </>

  if (embeddedIos) {
    if (!visible) return null
    return <View accessibilityViewIsModal style={styles.embeddedOverlay}>{details}</View>
  }

  return <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={historyVisible ? () => setHistoryVisible(false) : closeDetails}>
    {details}
  </Modal>
}

const styles = StyleSheet.create({
  rewardPolicy: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 12 },
  embeddedOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 400, elevation: 400, backgroundColor: '#FFF9F5' },
  safe: { flex: 1, backgroundColor: '#FFF9F5' },
  header: { height: 58, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#EEE7E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerButton: { width: 70, minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 }, close: { color: '#F26B4B', fontSize: 15, fontWeight: '900' }, title: { color: '#1F2937', fontSize: 17, fontWeight: '900' },
  content: { padding: 20, paddingBottom: 42 }, balanceCard: { minHeight: 106, borderRadius: 19, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6', padding: 18, justifyContent: 'center' }, balanceLabel: { color: '#78716C', fontSize: 12, fontWeight: '700' }, balance: { color: '#E85D3B', fontSize: 30, fontWeight: '900', marginTop: 7 },
  chargeButton: { minHeight: 48, borderRadius: 13, backgroundColor: '#FFF0F4', borderWidth: 1, borderColor: '#F3CCD8', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 14 }, chargeText: { color: '#B83D60', fontSize: 14, fontWeight: '900' }, arrow: { color: '#D94F70', fontSize: 22, fontWeight: '900' },
  attendanceButton: { minHeight: 46, borderRadius: 13, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center', marginTop: 10 }, attendanceText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' }, disabled: { backgroundColor: '#E7E5E4' },
  historyButton: { minHeight: 68, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 18 }, historyButtonTitle: { color: '#292524', fontSize: 14, fontWeight: '900' }, historyButtonDescription: { color: '#8B817A', fontSize: 10, marginTop: 4 }, historyContent: { padding: 20, paddingBottom: 42 }, historyCard: { backgroundColor: '#FFFFFF', borderRadius: 17, borderWidth: 1, borderColor: '#F0EAE6', overflow: 'hidden' }, empty: { color: '#8B817A', fontSize: 12, textAlign: 'center', paddingVertical: 30 }, transaction: { minHeight: 68, paddingHorizontal: 15, paddingVertical: 12, flexDirection: 'row', alignItems: 'center' }, transactionBorder: { borderTopWidth: 1, borderTopColor: '#F3EEEA' }, transactionBody: { flex: 1, marginRight: 12 }, reason: { color: '#292524', fontSize: 13, fontWeight: '800' }, date: { color: '#A8A29E', fontSize: 10, marginTop: 5 }, amount: { fontSize: 14, fontWeight: '900' }, earned: { color: '#E85D3B' }, spent: { color: '#57534E' },
})

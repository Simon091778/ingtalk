import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Text, TextInput } from '../i18n/localizedUi'
import { supabase } from '../lib/supabase'
import { SwipeDismissView } from './SwipeDismissView'
import { useI18n } from '../i18n'

type SupportThread = { id: string; status: 'open' | 'closed' }
type SupportMessage = { id: number; thread_id: string; sender_type: 'user' | 'admin'; body: string; created_at: string }

export function SupportCenter() {
  const i18n = useI18n()
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.locale, {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }), [i18n.locale])
  const [visible, setVisible] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)
  const [thread, setThread] = useState<SupportThread | null>(null)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const listRef = useRef<FlatList<SupportMessage>>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const { data: threadData, error } = await supabase.from('support_threads').select('id, status').maybeSingle()
    if (error) Alert.alert('문의를 불러오지 못했어요', error.message)
    const nextThread = (threadData as SupportThread | null) ?? null
    setThread(nextThread)
    if (nextThread) {
      const { data, error: messageError } = await supabase.from('support_messages').select('id, thread_id, sender_type, body, created_at').eq('thread_id', nextThread.id).order('created_at')
      if (messageError) Alert.alert('메시지를 불러오지 못했어요', messageError.message)
      else setMessages((data ?? []) as SupportMessage[])
      await supabase.rpc('mark_my_support_read')
    } else setMessages([])
    setLoading(false)
  }, [])

  useEffect(() => { if (visible) void load() }, [visible, load])
  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true))
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false))
    return () => { shown.remove(); hidden.remove() }
  }, [])
  useEffect(() => {
    if (!visible || !thread || !supabase) return
    const channel = supabase.channel(`support:${thread.id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages', filter: `thread_id=eq.${thread.id}` }, payload => {
      const next = payload.new as SupportMessage
      setMessages(current => current.some(item => item.id === next.id) ? current : [...current, next])
      void supabase?.rpc('mark_my_support_read')
    }).subscribe()
    return () => { void supabase?.removeChannel(channel) }
  }, [visible, thread?.id])

  const send = async () => {
    const normalized = body.trim()
    if (!supabase || !normalized || sending) return
    setSending(true)
    const { data, error } = await supabase.rpc('send_support_message', { message_body: normalized })
    setSending(false)
    if (error) { Alert.alert('문의를 보내지 못했어요', error.message.includes('function') ? '고객센터 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message); return }
    setBody('')
    if (!thread) setThread({ id: String(data), status: 'open' })
    await load()
  }

  return <>
    <View style={styles.card}><View style={styles.cardText}><Text style={styles.title}>{i18n.t('support')}</Text><Text style={styles.description}>{i18n.t('supportDescription')}</Text></View><Pressable accessibilityRole="button" onPress={() => { setClosingBySwipe(false); setVisible(true) }} style={styles.openButton}><Text style={styles.openButtonText}>{i18n.t('contact')}</Text></Pressable></View>
    <Modal visible={visible} animationType={Platform.OS === 'android' ? 'fade' : closingBySwipe ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={() => setVisible(false)}>
      <SwipeDismissView onDismissStart={() => setClosingBySwipe(true)} onDismiss={() => setVisible(false)}>
      <SafeAreaView edges={keyboardVisible && Platform.OS === 'ios' ? ['top'] : ['top', 'bottom']} style={styles.safe}><KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="고객센터 닫기" hitSlop={14} onPress={() => setVisible(false)} style={styles.headerButton}><Text style={styles.close}>닫기</Text></Pressable><Text style={styles.headerTitle}>고객센터 문의</Text><View style={styles.headerButton} /></View>
        <View style={styles.notice}><Text style={styles.noticeText}>운영시간과 문의량에 따라 답변이 늦어질 수 있어요. 긴급한 위험은 관계 기관에 바로 연락해 주세요.</Text></View>
        {loading ? <View style={styles.center}><ActivityIndicator color="#D94F70" /></View> : <FlatList ref={listRef} data={messages} keyExtractor={item => String(item.id)} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={styles.messageList} onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })} ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>무엇을 도와드릴까요?</Text><Text style={styles.emptyText}>문의 내용을 보내면 운영자가 이곳으로 답변해 드립니다</Text></View>} renderItem={({ item }) => <View style={[styles.message, item.sender_type === 'user' ? styles.myMessage : styles.adminMessage]}><Text style={[styles.sender, item.sender_type === 'user' && styles.mySender]}>{item.sender_type === 'user' ? '나' : '잉톡 운영자'}</Text><Text style={[styles.messageBody, item.sender_type === 'user' && styles.myMessageBody]}>{item.body}</Text><Text style={[styles.time, item.sender_type === 'user' && styles.myTime]}>{timeFormatter.format(new Date(item.created_at))}</Text></View>} />}
        <View style={styles.composer}><TextInput value={body} onChangeText={setBody} onFocus={() => { requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true })); setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 220) }} multiline maxLength={2000} placeholder="문의 내용을 입력하세요" placeholderTextColor="#A8A29E" style={styles.input} /><Pressable disabled={!body.trim() || sending} onPress={() => void send()} style={[styles.sendButton, (!body.trim() || sending) && styles.disabled]}>{sending ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.sendText}>전송</Text>}</Pressable></View>
      </KeyboardAvoidingView></SafeAreaView>
      </SwipeDismissView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  card: { minHeight: 68, marginTop: 14, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' }, cardText: { flex: 1, marginRight: 12 }, title: { color: '#292524', fontSize: 14, fontWeight: '900' }, description: { color: '#78716C', fontSize: 10, marginTop: 4 }, openButton: { minWidth: 72, minHeight: 38, borderRadius: 10, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, openButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, header: { minHeight: 60, paddingTop: 3, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#EEE4E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerButton: { width: 82, minHeight: 52, paddingHorizontal: 10, justifyContent: 'center' }, close: { color: '#D94F70', fontSize: 15, fontWeight: '900' }, headerTitle: { color: '#292524', fontSize: 17, fontWeight: '900' }, notice: { margin: 12, padding: 12, borderRadius: 12, backgroundColor: '#FFF0F2' }, noticeText: { color: '#8A4B59', fontSize: 10, lineHeight: 16 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { flexGrow: 1, padding: 16, gap: 9 }, empty: { flex: 1, minHeight: 320, alignItems: 'center', justifyContent: 'center' }, emptyTitle: { color: '#292524', fontSize: 17, fontWeight: '900' }, emptyText: { color: '#8B817A', fontSize: 11, marginTop: 7 }, message: { maxWidth: '82%', padding: 12, borderRadius: 15 }, myMessage: { alignSelf: 'flex-end', backgroundColor: '#D94F70', borderBottomRightRadius: 5 }, adminMessage: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderBottomLeftRadius: 5 }, sender: { color: '#B34763', fontSize: 9, fontWeight: '900', marginBottom: 5 }, mySender: { color: '#FFE4EA' }, messageBody: { color: '#292524', fontSize: 14, lineHeight: 20 }, myMessageBody: { color: '#FFFFFF' }, time: { color: '#A8A29E', fontSize: 8, marginTop: 6, alignSelf: 'flex-end' }, myTime: { color: '#FFD7E0' },
  composer: { padding: 10, borderTopWidth: 1, borderTopColor: '#EEE4E2', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'flex-end', gap: 8 }, input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 18, backgroundColor: '#F7F3F1', paddingHorizontal: 14, paddingVertical: 11, color: '#292524', fontSize: 14 }, sendButton: { width: 58, minHeight: 44, borderRadius: 15, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, sendText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' }, disabled: { opacity: 0.4 },
})

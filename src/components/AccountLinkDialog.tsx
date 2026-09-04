import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLinkPhoneClient, discardLinkClient, finishAccountLink, type AccountLinkRequest } from '../lib/accountLinking'
import { authErrorText, normalizePhone } from '../lib/phoneAuth'
import { signInWithGoogle } from '../lib/googleAuth'
import { signInWithKakao } from '../lib/kakaoAuth'
import { prepareSmsCodeAutofill } from '../lib/smsCodeAutofill'

export function AccountLinkDialog({ client, request, english, onClose, onLinked }: {
  client: SupabaseClient; request: AccountLinkRequest; english: boolean; onClose: () => void; onLinked: () => void
}) {
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [sent, setSent] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const active = useRef(true)
  const locked = useRef(false)
  const socialAbort = useRef<AbortController | null>(null)
  const isolated = useRef<SupabaseClient | null>(null)
  const stopAutofill = useRef<() => void>(() => {})
  const t = (ko: string, en: string) => english ? en : ko
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { active.current = false; socialAbort.current?.abort(); stopAutofill.current(); clearInterval(timer); if (isolated.current) void discardLinkClient(isolated.current) }
  }, [])
  async function run(action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await action() } catch (reason) { if (active.current) setError(authErrorText(reason, english)) }
    finally {
      locked.current = false
      if (active.current) setBusy(false)
      else if (isolated.current) await discardLinkClient(isolated.current)
    }
  }
  async function sendCode() {
    if (Date.now() < resendAt) return
    const normalized = normalizePhone(phone)
    isolated.current ??= createLinkPhoneClient()
    stopAutofill.current()
    stopAutofill.current = await prepareSmsCodeAutofill(code => { if (active.current) setOtp(code) })
    if (!active.current) { stopAutofill.current(); return }
    const { error } = await isolated.current.auth.signInWithOtp({ phone: normalized, options: { shouldCreateUser: true, channel: 'sms' } })
    if (error) { stopAutofill.current(); throw error }
    if (active.current) { setPhone(normalized); setSent(true); setResendAt(Date.now() + 60_000) }
  }
  async function verify() {
    if (!isolated.current || !sent || !/^\d{6}$/.test(otp)) return
    stopAutofill.current()
    const verification = await isolated.current.auth.verifyOtp({ phone: normalizePhone(phone), token: otp, type: 'sms' })
    if (verification.error) throw verification.error
    if (!active.current) return
    const result = await finishAccountLink(isolated.current, request)
    await discardLinkClient(isolated.current)
    if (active.current) { setRecovered(result.recoveredExistingAccount); setCompleted(true) }
  }
  async function social() {
    const signIn = request.provider === 'kakao' ? signInWithKakao : signInWithGoogle
    const controller = new AbortController()
    socialAbort.current = controller
    try {
      let recoveredExistingAccount = false
      const linked = await signIn(client, () => active.current, async verified => {
        recoveredExistingAccount = (await finishAccountLink(verified, request)).recoveredExistingAccount
      }, controller.signal)
      if (linked && active.current && !controller.signal.aborted) { setRecovered(recoveredExistingAccount); setCompleted(true) }
    } finally { socialAbort.current = null }
  }
  const close = () => { if (!locked.current) { if (completed) onLinked(); else onClose() } }
  const button = (label: string, action: () => Promise<void>, disabled = false) => <Pressable accessibilityRole="button"
    disabled={busy || disabled} accessibilityState={{ disabled: busy || disabled }}
    style={[styles.button, (busy || disabled) && styles.disabled]} onPress={() => void run(action)}><Text style={styles.buttonText}>{label}</Text></Pressable>
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaProvider style={styles.root}><SafeAreaView style={styles.safe} accessibilityViewIsModal onAccessibilityEscape={close}>
      <View style={styles.header}><Pressable accessibilityRole="button" disabled={busy} onPress={close} style={styles.close}><Text>{t('닫기', 'Close')}</Text></Pressable>
        <Text accessibilityRole="header" style={styles.title}>{t('로그인 수단 연결', 'Link a sign-in method')}</Text></View>
      <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {completed ? <>
          <Text accessibilityRole="alert" style={styles.description}>{recovered
            ? t('기존 계정으로 복구하고 휴대폰 번호를 연결했습니다. 기존 프로필·포인트·대화를 그대로 이용합니다.', 'Recovered your existing account and linked this phone number. Your existing profile, points and chats are unchanged.')
            : t('연결되었습니다. 등록된 기기에서는 연결한 수단으로 같은 계정을 이용합니다. 연결한 Google·카카오 계정은 다른 휴대폰에서도 기존 포인트와 대화를 이어 씁니다.', 'Linked. Your linked methods use the same account on registered devices. A linked Google or Kakao account also restores your points and chats on another phone.')}</Text>
          <Pressable accessibilityRole="button" style={styles.button} onPress={onLinked}><Text style={styles.buttonText}>{t('확인', 'Done')}</Text></Pressable>
        </> : <>
          <Text style={styles.description}>{request.provider === 'phone'
            ? t('인증한 번호가 휴대폰 전용 계정에 사용 중이면 두 계정 중 높은 포인트 잔액을 유지하고, 그 계정의 나머지 데이터는 이전하지 않고 삭제한 뒤 번호를 현재 Google·카카오 계정에 연결합니다. Google·카카오가 연결된 다른 계정은 자동 삭제하지 않습니다.', 'If this number belongs to a phone-only account, the higher point balance is kept, its other data is not transferred, and the number is linked to your current Google or Kakao account. Another account linked to Google or Kakao is not automatically deleted.')
            : t('기존 Google·카카오 계정을 인증해도 현재 로그인된 휴대폰 계정의 프로필·결제·대화·게시글을 그대로 유지합니다. 과거 소셜 계정의 콘텐츠는 가져오지 않고 로그인 수단과 더 높은 포인트 잔액만 현재 계정에 반영합니다.', 'Even when you verify an existing Google or Kakao account, the profile, purchases, chats and posts of your current phone account are kept. Past Social content is not imported; only its sign-in methods and a higher point balance are applied to the current account.')}</Text>
          <Text style={styles.description}>{t('5분 안에 추가 인증을 완료해 주세요. 취소하면 현재 로그인은 유지됩니다.', 'Complete verification within 5 minutes. Cancelling keeps your current session.')}</Text>
          {request.provider !== 'phone' ? button(request.provider === 'kakao' ? t('카카오 인증 후 연결', 'Verify Kakao and link') : t('Google 인증 후 연결', 'Verify Google and link'), social) : <>
            <TextInput accessibilityLabel="Link phone number" placeholder="01012345678 / +821012345678" value={phone}
              onChangeText={setPhone} editable={!busy && !sent} keyboardType="phone-pad" style={styles.input}
              autoComplete={Platform.OS === 'ios' ? undefined : 'tel'} textContentType={Platform.OS === 'ios' ? 'telephoneNumber' : undefined} importantForAutofill="yes" />
            {button(t('인증번호 받기', 'Send SMS code'), sendCode, now < resendAt)}
            <TextInput accessibilityLabel="Link SMS code" placeholder={t('인증번호 6자리', '6-digit code')} value={otp}
              onChangeText={value => { stopAutofill.current(); setOtp(value) }} editable={!busy && sent} keyboardType="number-pad" maxLength={6}
              autoComplete={Platform.OS === 'ios' ? 'one-time-code' : 'sms-otp'} importantForAutofill="yes" style={styles.input} />
            {button(t('인증번호 확인 후 연결', 'Verify code and link'), verify, !sent || !/^\d{6}$/.test(otp))}
            {now < resendAt && <Text style={styles.description}>{t(`다시 받기까지 ${Math.ceil((resendAt - now) / 1000)}초`, `Send again in ${Math.ceil((resendAt - now) / 1000)}s`)}</Text>}
          </>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {busy && <ActivityIndicator />}
          {busy && request.provider !== 'phone' && <Pressable accessibilityRole="button" style={styles.close} onPress={() => socialAbort.current?.abort()}>
            <Text>{t('인증 취소', 'Cancel verification')}</Text>
          </Pressable>}
        </>}
      </ScrollView>
    </SafeAreaView></SafeAreaProvider>
  </Modal>
}
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, safe: { flex: 1, backgroundColor: '#FFF9F5' },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#E7DFDA', flexShrink: 0 },
  close: { minHeight: 48, minWidth: 72, padding: 16, justifyContent: 'center' }, title: { flex: 1, fontSize: 18, fontWeight: '700' },
  body: { padding: 24, gap: 12, width: '100%', maxWidth: 640, alignSelf: 'center' }, description: { color: '#57534E', lineHeight: 22 },
  input: { borderWidth: 1, borderColor: '#D6D3D1', borderRadius: 12, padding: 14, fontSize: 16, backgroundColor: 'white' },
  button: { minHeight: 48, padding: 15, borderRadius: 12, backgroundColor: '#F26B4B', alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: '700' }, disabled: { opacity: 0.45 }, error: { color: '#B91C1C' },
})

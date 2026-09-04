import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLinkPhoneClient, discardLinkClient, reauthorizeAccountSession, type LoginProvider } from '../lib/accountLinking'
import { authErrorText, normalizePhone, phoneInputValue } from '../lib/phoneAuth'
import { signInWithGoogle } from '../lib/googleAuth'
import { signInWithKakao } from '../lib/kakaoAuth'
import { prepareSmsCodeAutofill } from '../lib/smsCodeAutofill'

export function AccountReauthenticationDialog({ client, accountId, provider, initialPhone, english, onClose, onReauthenticated }: {
  client: SupabaseClient; accountId: string; provider: LoginProvider; initialPhone: string; english: boolean;
  onClose: () => void; onReauthenticated: () => void;
}) {
  const expectedPhone = useRef('')
  if (provider === 'phone' && !expectedPhone.current) {
    try { expectedPhone.current = normalizePhone(initialPhone) } catch { /* handled when sending */ }
  }
  const [phone, setPhone] = useState(() => {
    if (provider !== 'phone') return initialPhone
    try { return phoneInputValue(initialPhone) } catch { return initialPhone }
  })
  const [otp, setOtp] = useState('')
  const [sent, setSent] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const locked = useRef(false)
  const isolated = useRef<SupabaseClient | null>(null)
  const sentPhone = useRef('')
  const socialAbort = useRef<AbortController | null>(null)
  const stopAutofill = useRef<() => void>(() => {})
  const t = (ko: string, en: string) => english ? en : ko
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active.current = false; socialAbort.current?.abort(); stopAutofill.current(); clearInterval(timer)
      if (isolated.current) void discardLinkClient(isolated.current)
    }
  }, [])
  async function run(action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await action() } catch (reason) { if (active.current) setError(authErrorText(reason, english)) }
    finally { locked.current = false; if (active.current) setBusy(false) }
  }
  async function sendCode() {
    if (Date.now() < resendAt) return
    const normalized = normalizePhone(phone)
    if (!expectedPhone.current || normalized !== expectedPhone.current) throw new Error('phone_reauthentication_mismatch')
    isolated.current ??= createLinkPhoneClient()
    stopAutofill.current()
    stopAutofill.current = await prepareSmsCodeAutofill(code => { if (active.current) setOtp(code) })
    if (!active.current) { stopAutofill.current(); return }
    const result = await isolated.current.auth.signInWithOtp({ phone: normalized, options: { shouldCreateUser: false, channel: 'sms' } })
    if (result.error) { stopAutofill.current(); throw result.error }
    if (active.current) { sentPhone.current = normalized; setSent(true); setResendAt(Date.now() + 60_000) }
  }
  async function verifyPhone() {
    if (!isolated.current || !sent || !/^\d{6}$/.test(otp)) return
    stopAutofill.current()
    if (!sentPhone.current || sentPhone.current !== expectedPhone.current) throw new Error('phone_reauthentication_mismatch')
    const verification = await isolated.current.auth.verifyOtp({ phone: sentPhone.current, token: otp, type: 'sms' })
    if (verification.error) throw verification.error
    await reauthorizeAccountSession(client, isolated.current, accountId)
    await discardLinkClient(isolated.current)
    isolated.current = null
    if (active.current) onReauthenticated()
  }
  async function verifySocial() {
    const signIn = provider === 'kakao' ? signInWithKakao : signInWithGoogle
    const controller = new AbortController()
    socialAbort.current = controller
    try {
      const verified = await signIn(client, () => active.current, async proof => { await reauthorizeAccountSession(client, proof, accountId) }, controller.signal)
      if (verified && active.current && !controller.signal.aborted) onReauthenticated()
    } finally { socialAbort.current = null }
  }
  const button = (label: string, action: () => Promise<void>, disabled = false) => <Pressable accessibilityRole="button"
    disabled={busy || disabled} accessibilityState={{ disabled: busy || disabled }}
    style={[styles.button, (busy || disabled) && styles.disabled]} onPress={() => void run(action)}><Text style={styles.buttonText}>{label}</Text></Pressable>
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => { if (!busy) onClose() }}>
    <SafeAreaProvider style={styles.root}><SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.header}><Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.close}><Text>{t('닫기', 'Close')}</Text></Pressable>
        <Text accessibilityRole="header" style={styles.title}>{t('현재 계정 다시 인증', 'Verify current account')}</Text></View>
      <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Text style={styles.description}>{t('로그아웃하지 않고 현재 계정의 소유권만 다시 확인한 뒤 선택한 로그인 수단 연결을 계속합니다.', 'Verify ownership of the current account without signing out, then continue linking the selected method.')}</Text>
        {provider === 'phone' ? <>
          <TextInput accessibilityLabel="Current phone number" placeholder="01012345678 / +821012345678" value={phone}
            onChangeText={setPhone} editable={!busy && !sent} keyboardType="phone-pad" style={styles.input}
            autoComplete={Platform.OS === 'ios' ? undefined : 'tel'} textContentType={Platform.OS === 'ios' ? 'telephoneNumber' : undefined} importantForAutofill="yes" />
          {button(t('현재 번호로 인증번호 받기', 'Send code to current number'), sendCode, now < resendAt)}
          <TextInput accessibilityLabel="Current account SMS code" placeholder={t('인증번호 6자리', '6-digit code')} value={otp}
            onChangeText={value => { stopAutofill.current(); setOtp(value) }} editable={!busy && sent} keyboardType="number-pad" maxLength={6}
            autoComplete={Platform.OS === 'ios' ? 'one-time-code' : 'sms-otp'} importantForAutofill="yes" style={styles.input} />
          {button(t('현재 계정 인증 후 계속', 'Verify and continue'), verifyPhone, !sent || !/^\d{6}$/.test(otp))}
          {now < resendAt && <Text style={styles.description}>{t(`다시 받기까지 ${Math.ceil((resendAt - now) / 1000)}초`, `Send again in ${Math.ceil((resendAt - now) / 1000)}s`)}</Text>}
        </> : button(provider === 'google' ? t('현재 Google 계정 다시 인증', 'Verify current Google account') : t('현재 카카오 계정 다시 인증', 'Verify current Kakao account'), verifySocial)}
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {busy && <ActivityIndicator />}
        {busy && provider !== 'phone' && <Pressable accessibilityRole="button" style={styles.close} onPress={() => socialAbort.current?.abort()}><Text>{t('인증 취소', 'Cancel verification')}</Text></Pressable>}
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

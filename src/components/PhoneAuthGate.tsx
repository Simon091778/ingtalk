import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Alert, AppState, Keyboard, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { authorizeDeviceAccount, authErrorText, normalizePhone, signOutAccount } from '../lib/phoneAuth'
import { getDeviceAccountKey } from '../lib/deviceAccountKey'
import { getDeviceReinstallIdentity } from '../lib/deviceReinstallIdentity'
import { activateLocalAccount } from '../lib/accountLocalState'
import { requestPhoneNumberHint, supportsPhoneNumberHint } from '../lib/phoneNumberHint'
import { prepareSmsCodeAutofill } from '../lib/smsCodeAutofill'
import { accountProvider, signInWithGoogle } from '../lib/googleAuth'
import { signInWithKakao } from '../lib/kakaoAuth'
import { PRIVACY_POLICY_TEXT } from '../content/legal'
import { PRIVACY_POLICY_TEXT_EN } from '../content/legal.en'
import { SwipeDismissView } from './SwipeDismissView'
import { addAppBreadcrumb } from '../lib/observability'
import { logPhoneAuthDiagnostic } from '../lib/phoneAuthDiagnostics'
import type { Session } from '@supabase/supabase-js'
import { AuthorizedAccountContext } from '../lib/authorizedAccount'
import { AppStartupScreen } from './AppStartupScreen'

type Stage = 'checking' | 'phone' | 'otp' | 'ready' | 'error'

// Only an authorized app principal mounts profile, purchase and notification hooks.
export function PhoneAuthGate({ children, language, renderPreviousStep }: {
  children: ReactNode
  language: 'ko' | 'en'
  renderPreviousStep?: (onContinue: () => void) => ReactNode
}) {
  const [previousStepVisible, setPreviousStepVisible] = useState(false)
  const [authMethod, setAuthMethod] = useState<'phone' | 'google' | 'kakao'>('phone')
  const [stage, setStage] = useState<Stage>('checking')
  const [accountId, setAccountId] = useState('')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletionPending, setDeletionPending] = useState(false)
  const [linkRequired, setLinkRequired] = useState(false)
  const [privacyVisible, setPrivacyVisible] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [hintBusy, setHintBusy] = useState(false)
  const hintAttempted = useRef(false)
  const hintPending = useRef(false)
  const phoneRevision = useRef(0)
  const otpRevision = useRef(0)
  const smsAutofillStop = useRef<() => void>(() => {})
  const lock = useRef(false)
  const socialAbort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const observedSession = useRef<Session | null>(null)
  const refreshPending = useRef<{ ticket: number; promise: Promise<void> } | null>(null)
  const mounted = useRef(true)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const privacyVisibleRef = useRef(privacyVisible)
  privacyVisibleRef.current = privacyVisible
  const english = language === 'en'
  const t = (ko: string, en: string) => english ? en : ko
  const canPickPhone = supportsPhoneNumberHint()

  function stopSmsAutofill() {
    smsAutofillStop.current()
    smsAutofillStop.current = () => {}
  }

  async function choosePhoneNumber() {
    if (!canPickPhone || hintPending.current || lock.current || stageRef.current !== 'phone') return
    hintPending.current = true
    setHintBusy(true)
    const revision = phoneRevision.current
    const ticket = generation.current
    try {
      const selected = await requestPhoneNumberHint()
      if (!mounted.current || ticket !== generation.current || stageRef.current !== 'phone'
        || lock.current || revision !== phoneRevision.current) return
      if (selected) { phoneRevision.current++; setPhone(selected) }
    } finally {
      hintPending.current = false
      if (mounted.current) setHintBusy(false)
    }
  }

  function refresh(): Promise<void> {
    const ticket = generation.current
    if (refreshPending.current?.ticket === ticket) return refreshPending.current.promise
    const promise = refreshAccount(ticket).finally(() => {
      if (refreshPending.current?.promise === promise) refreshPending.current = null
    })
    refreshPending.current = { ticket, promise }
    return promise
  }

  async function refreshAccount(ticket: number) {
    if (!mounted.current) return
    if (!supabase) { setStage('error'); return }
    const startedAt = Date.now()
    let resolutionStarted = false
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (ticket !== generation.current || !mounted.current) return
      if (sessionError) throw sessionError
      observedSession.current = session
      if (!session || session.user.is_anonymous) {
        if (ticket === generation.current) { setAccountId(''); setStage('phone') }
        return
      }
      logPhoneAuthDiagnostic('PHONE_AUTH_SESSION_AVAILABLE', { platform: Platform.OS })
      // Recheck the local key even for a restored Auth session.
      const provider = accountProvider(session.user)
      setAuthMethod(provider)
      const deviceSecret = await getDeviceAccountKey()
      const identity = await getDeviceReinstallIdentity(deviceSecret)
      if (ticket !== generation.current || !mounted.current) return
      resolutionStarted = true
      logPhoneAuthDiagnostic('PHONE_AUTH_ACCOUNT_RESOLVE_START', { provider, platform: Platform.OS })
      const result = await authorizeDeviceAccount(supabase, deviceSecret, identity, provider)
      if (ticket !== generation.current || !mounted.current) return
      logPhoneAuthDiagnostic('PHONE_AUTH_ACCOUNT_RESOLVE_SUCCESS', { provider, platform: Platform.OS })
      activateLocalAccount(result.account_id)
      setAccountId(result.account_id); setError(''); setDeletionPending(false); setLinkRequired(false); setStage('ready')
      addAppBreadcrumb('startup_account_ready', { duration_ms: Date.now() - startedAt, provider, platform: Platform.OS })
      logPhoneAuthDiagnostic('PHONE_AUTH_LOGIN_COMPLETE', { provider, platform: Platform.OS })
    } catch (reason) {
      if (ticket !== generation.current || !mounted.current) return
      if (resolutionStarted) logPhoneAuthDiagnostic('PHONE_AUTH_ACCOUNT_RESOLVE_FAILURE', {
        platform: Platform.OS,
        errorCode: reason instanceof Error ? reason.message : 'unknown',
      })
      setDeletionPending(reason instanceof Error && reason.message === 'account_deletion_pending')
      setLinkRequired(reason instanceof Error && reason.message === 'account_link_required')
      if (reason instanceof Error && ['reauthenticate_required', 'fresh_phone_verification_required', 'fresh_google_verification_required', 'fresh_kakao_verification_required'].includes(reason.message)) {
        try { await signOutAccount(supabase); return } catch { /* fail closed */ }
      }
      if (ticket !== generation.current || !mounted.current) return
      setError(authErrorText(reason, english)); setStage('error')
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    // Auth callbacks must not await operations while the Auth lock is held.
    const subscription = supabase?.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { stopSmsAutofill(); generation.current++; observedSession.current = null; setStage('phone'); setAccountId(''); setOtp('') }
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && !lock.current) {
        const sameSession = Boolean(session?.access_token && session.access_token === observedSession.current?.access_token
          && session.user.id === observedSession.current?.user.id)
        // Supabase may re-emit SIGNED_IN for the same session on focus/recovery.
        // Do not remount the entire app or repeat an already-running check.
        if (event === 'SIGNED_IN' && sameSession && (stageRef.current === 'ready' || refreshPending.current?.ticket === generation.current)) return
        const differentUser = !session || session.user.id !== observedSession.current?.user.id
        generation.current++
        observedSession.current = session
        if (event === 'SIGNED_IN' || differentUser) { stopSmsAutofill(); setStage('checking') }
        setTimeout(() => void refresh(), 0)
      }
    }).data.subscription
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active' && !lock.current && stageRef.current === 'ready') void refresh()
    })
    return () => { mounted.current = false; socialAbort.current?.abort(); stopSmsAutofill(); generation.current++; subscription?.unsubscribe(); appState.remove() }
  }, [])

  useEffect(() => {
    // No 1-second timer/render loop while the authenticated app is in use.
    setNow(Date.now())
    if (stage !== 'otp' || resendAt <= Date.now()) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= resendAt) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [stage, resendAt])

  useEffect(() => {
    // Ask once per auth-screen mount, only after regional selection and session
    // checks. Returning from the picker must not open it again automatically.
    if (previousStepVisible || authMethod !== 'phone' || stage !== 'phone' || !canPickPhone || hintAttempted.current) return
    hintAttempted.current = true
    if (!phone.trim()) void choosePhoneNumber()
  }, [stage, canPickPhone, previousStepVisible, authMethod])

  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setLinkRequired(false)
    try { await action() } catch (reason) { if (mounted.current) {
      setError(authErrorText(reason, english))
      setLinkRequired(reason instanceof Error && reason.message === 'account_link_required')
    } }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }

  function confirmSupportEmail() {
    if (lock.current || !mounted.current) return
    // Email is support only, never an OAuth continuation or a login fallback.
    Alert.alert(t('이메일로 고객지원 문의', 'Contact support by email'),
      t('로그인이 아닌 이메일 문의 기능입니다. 계속하면 Gmail·Outlook 등의 메일 앱이 열립니다.\n문의 주소: itembus@itembus.com',
        'This opens an email inquiry, not Google sign-in. Continuing opens a mail app such as Gmail or Outlook.\nSupport: itembus@itembus.com'), [
        { text: t('취소', 'Cancel'), style: 'cancel' },
        { text: t('메일 앱 열기', 'Open mail app'), onPress: async () => {
          if (lock.current || !mounted.current) return
          addAppBreadcrumb('auth_support_email_open_requested', { platform: Platform.OS })
          try { await Linking.openURL('mailto:itembus@itembus.com?subject=Ingtalk%20sign-in%20help') }
          catch {
            if (mounted.current) Alert.alert(t('메일 앱을 열 수 없어요', 'Could not open a mail app'),
              t('itembus@itembus.com으로 문의해 주세요. 로그인은 인증 화면에서 계속할 수 있습니다.',
                'Email itembus@itembus.com for support. You can continue signing in on the authentication screen.'))
          }
        } },
      ])
  }

  async function sendCode() {
    if (!supabase || Date.now() < resendAt) return
    const normalized = normalizePhone(phone)
    // Verify persistence before sending a billable SMS or creating an account.
    await getDeviceReinstallIdentity(await getDeviceAccountKey())
    stopSmsAutofill()
    const revision = ++otpRevision.current
    const ticket = generation.current
    let active = true
    let sent = false
    let earlyCode = ''
    const stop = await prepareSmsCodeAutofill(code => {
      if (!active || !mounted.current || ticket !== generation.current || revision !== otpRevision.current) return
      if (!/^\d{6}$/.test(code)) return
      if (sent) setOtp(code)
      else earlyCode = code
    })
    if (!mounted.current || ticket !== generation.current) { active = false; stop(); return }
    smsAutofillStop.current = () => { active = false; stop() }
    try {
      logPhoneAuthDiagnostic('PHONE_AUTH_OTP_REQUEST_START', { platform: Platform.OS })
      const { error } = await supabase.auth.signInWithOtp({ phone: normalized, options: { shouldCreateUser: true, channel: 'sms' } })
      if (error) throw error
      if (!mounted.current || ticket !== generation.current) { stopSmsAutofill(); return }
      sent = true
      logPhoneAuthDiagnostic('PHONE_AUTH_OTP_REQUEST_SUCCESS', { platform: Platform.OS })
      setPhone(normalized); setOtp(earlyCode); setResendAt(Date.now() + 60_000); setStage('otp')
    } catch (reason) {
      logPhoneAuthDiagnostic('PHONE_AUTH_OTP_REQUEST_FAILURE', { platform: Platform.OS, errorCode: 'otp_request_failed' })
      stopSmsAutofill(); throw reason
    }
  }

  async function socialSignIn(provider: 'google' | 'kakao') {
    if (!supabase) throw new Error(`${provider}_not_configured`)
    stopSmsAutofill(); Keyboard.dismiss()
    const ticket = generation.current
    const signIn = provider === 'google' ? signInWithGoogle : signInWithKakao
    const controller = new AbortController()
    socialAbort.current = controller
    try {
      const success = await signIn(supabase, () => mounted.current && ticket === generation.current, undefined, controller.signal)
      if (success && mounted.current && !controller.signal.aborted) { setOtp(''); setStage('checking'); await refresh() }
    } finally { socialAbort.current = null }
  }

  async function verifyCode() {
    if (!supabase || stage !== 'otp' || !/^\d{6}$/.test(otp)) return
    stopSmsAutofill()
    logPhoneAuthDiagnostic('PHONE_AUTH_VERIFY_START', { platform: Platform.OS })
    const { data, error } = await supabase.auth.verifyOtp({ phone: normalizePhone(phone), token: otp, type: 'sms' })
    if (error) {
      logPhoneAuthDiagnostic('PHONE_AUTH_VERIFY_FAILURE', { platform: Platform.OS, errorCode: 'otp_verification_failed' })
      throw new Error('otp_verification_failed')
    }
    if (!data?.session) {
      logPhoneAuthDiagnostic('PHONE_AUTH_VERIFY_FAILURE', { platform: Platform.OS, errorCode: 'otp_session_missing' })
      throw new Error('otp_session_missing')
    }
    logPhoneAuthDiagnostic('PHONE_AUTH_VERIFY_SUCCESS', { platform: Platform.OS })
    logPhoneAuthDiagnostic('PHONE_AUTH_SESSION_AVAILABLE', { platform: Platform.OS })
    setOtp(''); setStage('checking')
    await refresh()
  }

  // Keep this gate mounted while editing regional choices so OTP, cooldown and
  // the one-time number-picker attempt survive the round trip.
  if (previousStepVisible && renderPreviousStep) return <>{renderPreviousStep(() => setPreviousStepVisible(false))}</>
  if (stage === 'checking') return <AppStartupScreen language={language} />
  if (stage === 'ready') return <AuthorizedAccountContext.Provider value={accountId}><View key={accountId} style={{ flex: 1 }}>
    {children}
  </View></AuthorizedAccountContext.Provider>
  const backDisabled = busy || hintBusy
  function goToPreviousStep() {
    if (!renderPreviousStep || lock.current || hintPending.current || stageRef.current === 'checking' || stageRef.current === 'ready' || privacyVisibleRef.current) return
    stopSmsAutofill(); Keyboard.dismiss(); setError(''); setPreviousStepVisible(true)
  }
  const button = (label: string, action: () => Promise<void>, disabled = false) => <Pressable accessibilityRole="button" disabled={busy || disabled} onPress={() => void run(action)} style={[styles.button, (busy || disabled) && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>
  return <SwipeDismissView onDismiss={goToPreviousStep} enabled={!!renderPreviousStep && !backDisabled && !privacyVisible} enterFromRight={false} edgeWidth={24}>
    <SafeAreaView style={styles.safe}>
    {renderPreviousStep && <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('언어·국가 선택으로 돌아가기', 'Back to language and country')} accessibilityState={{ disabled: backDisabled }} disabled={backDisabled} onPress={goToPreviousStep} style={[styles.backButton, backDisabled && styles.disabled]}>
        <Text style={styles.backIcon} accessible={false}>‹</Text><Text style={styles.backText}>{t('언어·국가 선택', 'Language & country')}</Text>
      </Pressable>
    </View>}
    <ScrollView testID="auth-scroll" style={styles.authScroll} contentContainerStyle={[styles.content, renderPreviousStep && styles.contentWithHeader]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <Text style={styles.brand}>{t('잉톡 인증', 'Ingtalk Authentication')}</Text>
    <View style={styles.authTabs} accessibilityRole="tablist">
      {(['phone', 'google', 'kakao'] as const).map(method => <Pressable key={method} accessibilityRole="tab" accessibilityState={{ selected: authMethod === method, disabled: backDisabled }} disabled={backDisabled} onPress={() => {
        if (lock.current || hintPending.current || stageRef.current === 'checking') return
        if (method !== authMethod) { stopSmsAutofill(); Keyboard.dismiss(); setError(''); setLinkRequired(false); setAuthMethod(method) }
      }} style={[styles.authTab, authMethod === method && styles.authTabSelected, backDisabled && styles.disabled]}>
        <Text style={[styles.authTabText, authMethod === method && styles.authTabTextSelected]}>{method === 'phone' ? t('전화번호', 'Phone') : method === 'google' ? t('Google 계정', 'Google Account') : t('카카오톡', 'KakaoTalk')}</Text>
      </Pressable>)}
    </View>
    {authMethod === 'phone' && <View testID="phone-privacy-summary" style={styles.privacySummaryRow}>
      <Text style={styles.privacySummary} numberOfLines={1} adjustsFontSizeToFit>{t('전화번호는 다른 이용자에게 공개되지 않습니다.', 'Your number is not shown to other users.')}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || stage !== 'otp' }} disabled={busy || stage !== 'otp'} hitSlop={6} onPress={() => {
        if (lock.current || stageRef.current !== 'otp') return
        stopSmsAutofill(); setStage('phone'); setOtp(''); setError('')
      }} style={[styles.editNumberLink, (busy || stage !== 'otp') && styles.disabled]}>
        <Text style={styles.editNumberText}>{t('번호수정', 'Edit number')}</Text>
      </Pressable>
    </View>}
    {authMethod === 'google' && <View style={styles.providerPreview}>
      <Text style={styles.description}>{t('Google 계정 정보는 다른 이용자에게 공개되지 않습니다. 같은 Google 계정은 기존 계정으로, 처음 사용하는 계정은 새 계정으로 시작합니다.', 'Your Google information is not shown to others. Use the same Google account to return, or a new one to start a separate account.')}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: backDisabled, busy }} disabled={backDisabled} onPress={() => void run(() => socialSignIn('google'))} style={[styles.googleButton, backDisabled && styles.disabled]}>
        <Text style={styles.googleButtonText}>{t('Google로 계속하기', 'Continue with Google')}</Text>
      </Pressable>
    </View>}
    {authMethod === 'kakao' && <View style={styles.providerPreview}>
      <Text style={styles.description}>{t('카카오 닉네임·프로필 사진·이메일은 요청하지 않습니다. 같은 카카오 계정은 기존 계정으로, 처음 사용하는 계정은 새 계정으로 시작합니다.', 'We do not request your Kakao nickname, profile photo or email. Use the same Kakao account to return, or a new one to start a separate account.')}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: backDisabled, busy }} disabled={backDisabled} onPress={() => void run(() => socialSignIn('kakao'))} style={[styles.kakaoButton, backDisabled && styles.disabled]}>
        <Text style={styles.kakaoButtonText}>{t('카카오로 계속하기', 'Continue with Kakao')}</Text>
      </Pressable>
    </View>}
    {busy && authMethod !== 'phone' && socialAbort.current && <View style={styles.providerPreview}>
      <Text style={styles.description}>{t('인증을 마치면 자동으로 돌아옵니다. 로그인 창을 닫았다면 취소 후 다시 시도해 주세요.', 'You will return automatically after verification. If you closed the sign-in window, cancel and try again.')}</Text>
      <Pressable accessibilityRole="button" onPress={() => socialAbort.current?.abort()} style={styles.hintButton}><Text>{t('인증 취소', 'Cancel verification')}</Text></Pressable>
    </View>}
    {stage === 'error' && button(t('다시 확인', 'Retry'), refresh)}
    {stage === 'error' && deletionPending && button(t('요청한 계정 삭제 마무리', 'Finish requested account deletion'), async () => {
      if (!supabase) return
      const { data, error } = await supabase.functions.invoke('delete-account', { body: { confirmation: true } })
      if (error || data?.deleted !== true) throw new Error('account_deletion_pending')
      const result = await supabase.auth.signOut({ scope: 'local' })
      if (result.error) throw result.error
      setDeletionPending(false); setStage('phone')
    })}
    {authMethod === 'phone' && (stage === 'phone' || stage === 'otp') && <View testID="phone-auth-form" style={styles.authForm}>
      <TextInput accessibilityLabel="Phone number" value={phone.replace(/^\+8210(?=\d{8}$)/, '010')} onChangeText={value => { phoneRevision.current++; setPhone(value) }} editable={!busy && stage === 'phone'} keyboardType="phone-pad" autoComplete={Platform.OS === 'ios' ? undefined : 'tel'} textContentType={Platform.OS === 'ios' ? 'telephoneNumber' : undefined} importantForAutofill="yes" placeholder="01012345678 / +821012345678" style={styles.input} />
      {button(t('인증번호 받기', 'Send SMS code'), sendCode, now < resendAt)}
      <View testID="phone-verification-controls" style={styles.authForm}>
      <TextInput accessibilityLabel="SMS code" value={otp} onChangeText={value => { if (stage === 'otp') { otpRevision.current++; stopSmsAutofill(); setOtp(value) } }} editable={!busy && stage === 'otp'} keyboardType="number-pad" autoComplete={Platform.OS === 'ios' ? 'one-time-code' : 'sms-otp'} importantForAutofill="yes" placeholder={t('인증번호 6자리', '6-digit verification code')} maxLength={6} style={[styles.input, stage !== 'otp' && styles.inputInactive]} />
      {button(t('인증번호 확인', 'Verify code'), verifyCode, stage !== 'otp' || !/^\d{6}$/.test(otp))}
      {now < resendAt && <Text testID="phone-resend-countdown" style={styles.informationText}>{t(`다시 받기까지 ${Math.ceil((resendAt - now) / 1000)}초`, `Send again in ${Math.ceil((resendAt - now) / 1000)}s`)}</Text>}
      </View>
    </View>}
    {!!error && (linkRequired ? <View testID="account-link-required-guide" style={styles.linkGuide} accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" style={styles.linkGuideTitle}>{t('기존 계정에 연결이 필요해요', 'Link to your existing account')}</Text>
      <Text style={styles.description}>{error}</Text>
    </View> : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>)}
    {linkRequired && button(t('기존 로그인 방식으로 돌아가기', 'Return to the original sign-in method'), async () => {
      if (!supabase) return
      await signOutAccount(supabase)
      setLinkRequired(false); setError(''); setOtp(''); setStage('phone')
      // The server intentionally does not disclose the existing owner's provider.
      // Show the normal method picker instead of guessing which identity owns it.
      setAuthMethod('phone')
    })}
    {linkRequired && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.informationLink} onPress={confirmSupportEmail}>
      <Text style={styles.informationLinkText}>{t('이메일로 고객지원 문의', 'Contact support by email')}</Text>
    </Pressable>}
    {busy && <ActivityIndicator />}
    <View testID="phone-auth-information" style={styles.information}>
      <Pressable accessibilityRole="button" style={styles.informationLink} onPress={() => { Keyboard.dismiss(); setPrivacyVisible(true) }}><Text style={styles.informationLinkText}>{t('개인정보 처리 안내 보기', 'Read privacy information')}</Text></Pressable>
      <Text style={styles.informationText}>{t('같은 Google·카카오 계정은 다른 휴대폰에서도 기존 포인트와 대화를 이어 씁니다. 전화번호 복구는 기존 기기 확인이 필요합니다. 연결하지 않은 로그인 수단은 별도 계정이며 포인트는 자동으로 합치지 않습니다.', 'The same Google or Kakao account restores points and chats on another phone. Phone recovery requires the registered device. Unlinked sign-in methods use separate accounts; points are not merged automatically.')}</Text>
    </View>
    </ScrollView>
    <Modal visible={privacyVisible} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setPrivacyVisible(false)}>
      {/* A modal needs its own safe-area measurements, independent of the form. */}
      <SafeAreaProvider style={styles.privacyRoot}>
        <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.safe} accessibilityViewIsModal onAccessibilityEscape={() => setPrivacyVisible(false)}>
          <View style={styles.privacyHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('개인정보 안내 닫기', 'Close privacy information')} onPress={() => setPrivacyVisible(false)} style={styles.privacyClose}>
              <Text style={styles.privacyCloseText}>{t('닫기', 'Close')}</Text>
            </Pressable>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.privacyTitle}>{t('개인정보 처리 안내', 'Privacy information')}</Text>
            <View style={styles.privacyHeaderSpacer} />
          </View>
          <ScrollView testID="phone-privacy-body" style={styles.privacyScroll} contentContainerStyle={styles.privacyContent} showsVerticalScrollIndicator contentInsetAdjustmentBehavior="never">
            <Text selectable style={styles.privacyBody}>{english ? PRIVACY_POLICY_TEXT_EN : PRIVACY_POLICY_TEXT}</Text>
          </ScrollView>
          <View style={styles.privacyFooter}>
            <Pressable accessibilityRole="button" onPress={() => setPrivacyVisible(false)} style={styles.privacyDone}>
              <Text style={styles.buttonText}>{t('닫고 인증 계속하기', 'Close and continue verification')}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  </SafeAreaView>
  </SwipeDismissView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, content: { padding: 24, paddingTop: 24, gap: 10 },
  authScroll: { flex: 1, minHeight: 0 },
  header: { paddingHorizontal: 24, paddingTop: 4 }, contentWithHeader: { paddingTop: 8 },
  backButton: { minHeight: 44, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 12 },
  backIcon: { fontSize: 30, color: '#57534E' }, backText: { fontSize: 15, fontWeight: '600', color: '#57534E' },
  brand: { color: '#F26B4B', fontSize: 30, fontWeight: '900' }, title: { fontSize: 24, fontWeight: '800', color: '#292524' },
  description: { color: '#57534E', lineHeight: 22 }, input: { borderWidth: 1, borderColor: '#D6D3D1', backgroundColor: 'white', borderRadius: 12, padding: 14, fontSize: 16 },
  linkGuide: { padding: 16, gap: 8, borderRadius: 12, backgroundColor: '#FFF0E9' },
  linkGuideTitle: { fontSize: 16, fontWeight: '700', color: '#374151' },
  privacySummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  privacySummary: { flex: 1, color: '#57534E', fontSize: 13, lineHeight: 20 },
  editNumberLink: { minHeight: 32, justifyContent: 'center', flexShrink: 0 },
  editNumberText: { color: '#C24120', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  authTabs: { flexDirection: 'row', gap: 6 },
  authTab: { flex: 1, minHeight: 48, paddingVertical: 12, paddingHorizontal: 4, borderRadius: 10, borderWidth: 1, borderColor: '#D6D3D1', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  authTabSelected: { borderColor: '#C24120', backgroundColor: '#FFF0E8' },
  authTabText: { fontSize: 12, fontWeight: '600', color: '#57534E', textAlign: 'center' },
  authTabTextSelected: { color: '#C24120' },
  providerPreview: { padding: 20, gap: 12, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA' },
  providerTitle: { fontSize: 18, fontWeight: '700', color: '#292524' },
  googleButton: { minHeight: 48, padding: 14, borderWidth: 1, borderColor: '#747775', borderRadius: 12, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  googleButtonText: { color: '#1F1F1F', fontSize: 16, fontWeight: '600' },
  kakaoButton: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#FEE500', alignItems: 'center', justifyContent: 'center' },
  kakaoButtonText: { color: '#191919', fontSize: 16, fontWeight: '600' },
  authForm: { gap: 8 },
  inputInactive: { backgroundColor: '#F5F5F4', borderColor: '#E7E5E4' },
  information: { borderTopWidth: 1, borderTopColor: '#E7DFDA', paddingTop: 12, gap: 4 },
  informationLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  informationLinkText: { color: '#C24120', fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  informationText: { color: '#78716C', fontSize: 13, lineHeight: 20 },
  button: { backgroundColor: '#F26B4B', padding: 15, borderRadius: 12, alignItems: 'center' }, buttonText: { color: 'white', fontWeight: '800' },
  hintButton: { padding: 12, borderWidth: 1, borderColor: '#D6D3D1', borderRadius: 12, alignItems: 'center' },
  privacyRoot: { flex: 1 },
  privacyHeader: { flexShrink: 0, minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#E7DFDA' },
  privacyClose: { minWidth: 72, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center', alignItems: 'center' },
  privacyCloseText: { fontSize: 16, fontWeight: '700', color: '#C24120' },
  privacyTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#292524', textAlign: 'center' },
  privacyHeaderSpacer: { width: 72 },
  privacyScroll: { flex: 1, minHeight: 0 },
  privacyContent: { paddingHorizontal: 22, paddingVertical: 24, width: '100%', maxWidth: 720, alignSelf: 'center' },
  privacyBody: { color: '#57534E', fontSize: 15, lineHeight: 24 },
  privacyFooter: { flexShrink: 0, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#E7DFDA' },
  privacyDone: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 }, error: { color: '#B91C1C' },
})

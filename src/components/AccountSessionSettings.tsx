import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { useI18n } from '../i18n'
import { supabase } from '../lib/supabase'
import { authErrorText, signOutAccount } from '../lib/phoneAuth'
import { isExpoGoAuthTesting } from '../lib/expoGoAuth'
import { accountLoginMethods, beginAccountLink, type AccountLinkRequest, type LoginProvider } from '../lib/accountLinking'
import { AccountLinkDialog } from './AccountLinkDialog'
import { accountProvider, LOGIN_PROVIDERS } from '../lib/authProviders'
import { AccountSwitchButton } from './AccountSwitchButton'
import { SwipeDismissView } from './SwipeDismissView'
import { AccountReauthenticationDialog } from './AccountReauthenticationDialog'

export function AccountSessionSettings() {
  const { language } = useI18n()
  const t = (ko: string, en: string) => language === 'en' ? en : ko
  const expoGoTesting = isExpoGoAuthTesting()
  const [visible, setVisible] = useState(false)
  const [methods, setMethods] = useState<{ accountId: string; providers: LoginProvider[] } | null>(null)
  const [link, setLink] = useState<AccountLinkRequest | null>(null)
  const [reauth, setReauth] = useState<{ provider: LoginProvider; target: LoginProvider; phone: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preparingProvider, setPreparingProvider] = useState<LoginProvider | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const linkOpen = useRef(false)
  linkOpen.current = !!link || !!reauth
  async function loadMethods() {
    if (!supabase) return
    try {
      const result = await accountLoginMethods(supabase)
      if (mounted.current) { setMethods(result); setError('') }
    } catch (reason) { if (mounted.current) setError(authErrorText(reason, language === 'en')) }
  }
  useEffect(() => {
    mounted.current = visible
    if (visible) void loadMethods()
    return () => { mounted.current = false }
  }, [visible])
  function open() { setMethods(null); setError(''); setVisible(true) }
  // Swipe completion can arrive after a link dialog has opened.
  function close() { if (!pending.current && !linkOpen.current) setVisible(false) }
  async function connect(provider: LoginProvider) {
    if (!supabase || !methods || pending.current) return
    pending.current = true; setBusy(true); setPreparingProvider(provider); setError('')
    try {
      const request = await beginAccountLink(supabase, methods.accountId, provider)
      if (mounted.current) setLink(request)
    } catch (reason) {
      let displayReason = reason
      if (reason instanceof Error && reason.message === 'link_reauthentication_required') {
        try {
          const current = await supabase.auth.getSession()
          if (current.error || !current.data.session) throw new Error('account_service_unavailable')
          const source = accountProvider(current.data.session.user)
          if (mounted.current) {
            setReauth({ provider: source, target: provider, phone: current.data.session.user.phone ?? '' })
            return
          }
        } catch (reauthReason) { displayReason = reauthReason }
      }
      if (mounted.current) setError(authErrorText(displayReason, language === 'en'))
    }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setPreparingProvider(null) } }
  }
  // Keep recovery limitations at sign-out without changing the account screen layout.
  const testNotice = t('같은 번호와 이 기기에 저장된 로그인 정보가 남아 있으면 다시 로그인할 수 있습니다. 이 실행 환경에서는 재설치 복구와 정식 앱으로의 포인트 이전을 지원하지 않습니다.', 'You can sign in again with the same number while the saved sign-in information remains on this device. This environment does not support reinstall recovery or point transfers to the standalone app.')
  function signOut() {
    Alert.alert(t('로그아웃', 'Sign out'), expoGoTesting ? testNotice : t('같은 Google·카카오 계정으로 로그인하면 다른 휴대폰에서도 기존 포인트와 대화를 이어 쓸 수 있어요. 전화번호 인증은 등록된 기기에서만 기존 계정을 복구합니다. 로그아웃은 이 기기에만 적용됩니다.', 'The same linked Google or Kakao account restores your points and chats on another phone. Phone recovery requires a registered device. Signing out affects only this session.'), [
      { text: t('취소', 'Cancel'), style: 'cancel' },
      { text: t('로그아웃', 'Sign out'), onPress: () => { if (supabase) void signOutAccount(supabase).catch(reason => Alert.alert(t('로그아웃 확인 실패', 'Sign-out failed'), authErrorText(reason, language === 'en'))) } },
    ])
  }
  const title = t('로그인 및 계정 관리', 'Login & account management')
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={title} style={styles.menuCard} onPress={open}>
      <View style={styles.menuIcon}><Text style={styles.menuIconText}>↔</Text></View>
      <View style={styles.menuBody}>
        <Text style={styles.menuTitle}>{title}</Text>
        <Text style={styles.menuDescription}>{t('로그인 수단 연결 및 로그아웃', 'Linked sign-in methods and sign out')}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
    <Modal visible={visible} animationType="none" presentationStyle="fullScreen" onRequestClose={close}>
      <SafeAreaProvider style={styles.root}>
      <SwipeDismissView visible={visible} enterFromRight onDismiss={close} enabled={!busy && !link && !reauth}>
      <SafeAreaView style={styles.safe} accessibilityViewIsModal onAccessibilityEscape={close}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('내 정보로 돌아가기', 'Back to My Info')} disabled={busy || !!link}
            onPress={close} style={styles.headerButton}><Text style={styles.backText}>{t('뒤로', 'Back')}</Text></Pressable>
          <Text accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.notice}>{t('로그인 수단을 연결하면 현재 로그인된 계정의 프로필·결제·대화·게시글을 그대로 유지합니다. 과거 Google·카카오 계정의 콘텐츠는 가져오지 않고 로그인 수단만 연결하며, 포인트는 합산하지 않고 두 계정 중 높은 잔액을 유지합니다. 번호가 다른 사람에게 재할당되면 이전 소유자의 휴대폰 로그인은 해제됩니다.', 'Linking keeps the profile, purchases, chats and posts of the account you are currently using. Content from a past Google or Kakao account is not imported; only its sign-in methods are linked, and the higher point balance is kept without adding balances together. If the number is reassigned, the previous holder loses phone access.')}</Text>
    <Text style={[styles.notice, { marginTop: 12 }]}>{t('기존 포인트가 보이지 않나요? 이전에 사용한 로그인 방식으로 로그인해 주세요. 다른 계정으로 로그인해도 기존 포인트와 대화는 삭제되지 않습니다. 가입 보상은 로그인 수단을 바꿔도 반복 지급되지 않습니다.', 'Missing your previous points? Sign in with your previous method. Switching accounts does not delete existing points or chats. Changing methods does not repeat the signup bonus.')}</Text>
    <Text style={styles.heading}>{t('로그인 수단 연결', 'Linked sign-in methods')}</Text>
    {methods && <Text style={styles.notice}>{methods.providers.map(provider => provider === 'phone' ? t('전화번호', 'Phone') : provider === 'google' ? 'Google' : t('카카오톡', 'KakaoTalk')).join(' · ')} {t('연결됨', 'linked')}</Text>}
    {busy && preparingProvider && <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" style={styles.preparing}>
      <ActivityIndicator color="#F26B4B" />
      <Text style={styles.preparingText}>{preparingProvider === 'google' ? t('Google 연결 화면을 준비하고 있어요.', 'Preparing Google linking.')
        : preparingProvider === 'kakao' ? t('카카오 연결 화면을 준비하고 있어요.', 'Preparing Kakao linking.')
        : t('전화번호 연결 화면을 준비하고 있어요.', 'Preparing phone linking.')}</Text>
    </View>}
    {!busy && methods && LOGIN_PROVIDERS.filter(provider => !methods.providers.includes(provider)).map(provider => <Pressable key={provider} accessibilityRole="button" onPress={() => void connect(provider)} style={styles.button}>
      <Text>{provider === 'phone' ? t('전화번호 연결', 'Link phone number') : provider === 'google' ? t('Google 계정 연결', 'Link Google') : t('카카오 계정 연결', 'Link Kakao')}</Text>
    </Pressable>)}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!methods && <Pressable accessibilityRole="button" onPress={() => void loadMethods()} style={styles.button}><Text>{t('연결 상태 다시 확인', 'Retry linked methods')}</Text></Pressable>}
    {!busy && !link && !reauth && <AccountSwitchButton />}
    {!busy && !link && !reauth && <Pressable accessibilityRole="button" style={styles.button} onPress={signOut}><Text>{t('로그아웃', 'Sign out')}</Text></Pressable>}
        </ScrollView>
        {link && supabase && <AccountLinkDialog client={supabase} request={link} english={language === 'en'} onClose={() => { setLink(null); void loadMethods() }} onLinked={() => { setLink(null); void loadMethods() }} />}
        {reauth && methods && supabase && <AccountReauthenticationDialog client={supabase} accountId={methods.accountId}
          provider={reauth.provider} initialPhone={reauth.phone} english={language === 'en'} onClose={() => setReauth(null)}
          onReauthenticated={() => { const target = reauth.target; setReauth(null); void connect(target) }} />}
      </SafeAreaView>
      </SwipeDismissView>
      </SafeAreaProvider>
    </Modal>
  </>
}
const styles = StyleSheet.create({
  menuCard: { minHeight: 74, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, marginTop: 10, borderWidth: 1, borderColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center' },
  menuIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#FFF0E9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  menuIconText: { color: '#F26B4B', fontSize: 22, fontWeight: '700' }, menuBody: { flex: 1 },
  menuTitle: { color: '#374151', fontSize: 15, fontWeight: '900' }, menuDescription: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 4 },
  chevron: { color: '#A8A29E', fontSize: 27, marginLeft: 8 },
  root: { flex: 1, minHeight: 0 }, safe: { flex: 1, backgroundColor: '#FFF9F5' },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', flexShrink: 0, borderBottomWidth: 1, borderBottomColor: '#EEE7E2' },
  headerButton: { minWidth: 72, minHeight: 56, paddingHorizontal: 16, justifyContent: 'center' }, headerSpacer: { width: 72 },
  backText: { color: '#F26B4B', fontSize: 15, fontWeight: '700' }, headerTitle: { flex: 1, paddingVertical: 12, textAlign: 'center', color: '#1F2937', fontSize: 17, fontWeight: '700' },
  content: { padding: 20, paddingBottom: 40, width: '100%', maxWidth: 640, alignSelf: 'center' },
  preparing: { minHeight: 72, marginTop: 12, padding: 16, borderRadius: 12, backgroundColor: '#FFF0E9', flexDirection: 'row', alignItems: 'center', gap: 12 },
  preparingText: { flex: 1, color: '#9A3412', fontSize: 14, fontWeight: '700' },
  notice: { color: '#57534E', lineHeight: 21 }, heading: { marginTop: 16, marginBottom: 8, fontWeight: '700' }, error: { color: '#B91C1C', marginTop: 8 },
  button: { minHeight: 48, justifyContent: 'center', marginTop: 12, padding: 16, backgroundColor: '#FFF0E9', borderRadius: 12 },
})

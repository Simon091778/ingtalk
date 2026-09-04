import { useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text } from 'react-native'
import { useI18n } from '../i18n'
import { supabase } from '../lib/supabase'
import { authErrorText, signOutAccount } from '../lib/phoneAuth'

// Reuse the normal login gate after revoking this session. Never swap a wallet
// or reuse another account's cached profile just because the device is shared.
export function AccountSwitchButton({ beforeProfile = false, disabled = false }: { beforeProfile?: boolean; disabled?: boolean }) {
  const { language } = useI18n()
  const t = (ko: string, en: string) => language === 'en' ? en : ko
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const label = beforeProfile ? t('기존 계정으로 로그인', 'Sign in to an existing account') : t('다른 계정으로 로그인', 'Sign in to another account')
  async function changeAccount() {
    if (!supabase || pending.current || disabledRef.current || !mounted.current) return
    pending.current = true; setBusy(true)
    try { await signOutAccount(supabase) }
    catch (reason) {
      if (mounted.current) Alert.alert(t('계정 전환 실패', 'Could not switch accounts'), authErrorText(reason, language === 'en'))
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  function confirm() {
    if (pending.current || disabledRef.current || !mounted.current) return
    Alert.alert(label, beforeProfile
      ? t('이전 프로필이나 포인트가 있다면 새 프로필을 만들기 전에 이전 로그인 방식으로 로그인해 주세요. 기존 계정의 로그인 및 계정 관리에서 새 로그인 수단을 연결할 수 있습니다.',
        'To recover an existing profile or points, sign in with your previous method before creating a new profile. You can link the new method in that account’s Login & account management.')
      : t('현재 계정에서 로그아웃하고 인증 화면으로 이동합니다. 포인트와 대화는 각 계정에 그대로 보관되며 자동으로 합쳐지지 않습니다.',
        'Sign out and return to authentication. Each account keeps its own points and chats; they are not merged automatically.'), [
        { text: t('취소', 'Cancel'), style: 'cancel' },
        { text: t('로그인 화면으로', 'Go to sign-in'), onPress: () => { void changeAccount() } },
      ])
  }
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || disabled, busy }} disabled={busy || disabled}
    onPress={confirm} style={[styles.button, (busy || disabled) && styles.disabled]}>
    <Text style={styles.label}>{label}</Text>
  </Pressable>
}
const styles = StyleSheet.create({
  button: { minHeight: 48, justifyContent: 'center', marginTop: 12, padding: 16, borderRadius: 12, backgroundColor: '#FFF0E9' },
  label: { color: '#C24120', fontSize: 14, fontWeight: '600' }, disabled: { opacity: 0.45 },
})

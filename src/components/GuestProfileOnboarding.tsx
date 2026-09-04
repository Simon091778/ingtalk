import { getAccountId } from '../lib/phoneAuth'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable,
  ScrollView, StyleSheet, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Text, TextInput } from '../i18n/localizedUi'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { pickProfilePhoto, ProfilePhotoPermissionError, uploadProfilePhoto } from '../lib/profilePhoto'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { AgePickerSheet } from './AgePickerSheet'
import { AccountSwitchButton } from './AccountSwitchButton'
import { useAuthorizedAccountId } from '../lib/authorizedAccount'
import { useI18n } from '../i18n'
import { AppStartupScreen } from './AppStartupScreen'

const genders = [
  { value: 'male', label: '남성' },
  { value: 'female', label: '여성' },
  { value: 'other', label: '기타' },
  { value: 'private', label: '비공개' },
] as const

type Gender = typeof genders[number]['value']

export type GuestProfile = {
  nickname: string
  age: number
  gender: Gender
  avatarUrl?: string | null
}

export function GuestProfileOnboarding({ onComplete, onBack }: { onComplete: (profile: GuestProfile) => void; onBack?: () => void }) {
  const authorizedAccountId = useAuthorizedAccountId()
  const { language } = useI18n()
  const scrollRef = useRef<ScrollView>(null)
  const submitLockRef = useRef(false)
  const [checking, setChecking] = useState(true)
  const [profileLoadFailed, setProfileLoadFailed] = useState(false)
  const [profileRetry, setProfileRetry] = useState(0)
  const [nickname, setNickname] = useState('')
  const [age, setAge] = useState('')
  const [agePickerVisible, setAgePickerVisible] = useState(false)
  const [gender, setGender] = useState<Gender | null>(null)
  const [avatarUri, setAvatarUri] = useState<string | null>(null)
  const [avatarMimeType, setAvatarMimeType] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    const startedAt = Date.now()
    setChecking(true)
    setProfileLoadFailed(false)

    const findExistingProfile = async () => {
      if (!supabase) {
        const localProfile = localStorage.getItem('ingtalk.guest-profile.v1')
        if (localProfile) onComplete(JSON.parse(localProfile) as GuestProfile)
        else if (mounted) setChecking(false)
        return
      }

      const userId = authorizedAccountId ?? await getAccountId(supabase)
      if (!userId) throw new Error('verified_phone_required')
      if (!mounted) return

      const { error: suspensionError } = await supabase.rpc('refresh_my_suspension')
      if (suspensionError) throw suspensionError
      if (!mounted) return
      const { data, error: profileError } = await supabase.from('profiles').select('nickname, birth_year, gender, avatar_url, welcome_points_claimed').eq('id', userId).maybeSingle()
      if (profileError) throw profileError
      if (!mounted) return
      if (data) {
        // The persisted server flag proves this idempotent grant already ran.
        // Existing accounts do not need another global reward-lock RPC at launch.
        if (data.welcome_points_claimed !== true) {
          const { error: rewardError } = await supabase.rpc('claim_account_welcome_points')
          if (rewardError) throw rewardError
        }
        if (!mounted) return
        addAppBreadcrumb('startup_profile_ready', { duration_ms: Date.now() - startedAt, reused_authorized_id: Boolean(authorizedAccountId) })
        onComplete({
          nickname: data.nickname as string,
          age: new Date().getFullYear() - (data.birth_year as number),
          gender: data.gender as Gender,
          avatarUrl: data.avatar_url as string | null,
        })
      }
      else if (mounted) setChecking(false)
    }

    void findExistingProfile().catch(reason => {
      captureAppError(reason, 'onboarding', 'prepare_account_profile')
      if (mounted) { setProfileLoadFailed(true); setChecking(false) }
    })
    return () => { mounted = false }
  }, [onComplete, authorizedAccountId, profileRetry])

  const numericAge = Number(age)
  const nicknameValid = nickname.trim().length >= 2 && nickname.trim().length <= 9
  const ageValid = Number.isInteger(numericAge) && numericAge >= 19 && numericAge <= 80
  const canSubmit = nicknameValid && ageValid && gender !== null && !submitting

  const choosePhoto = async () => {
    try {
      const asset = await pickProfilePhoto()
      if (asset) { setAvatarUri(asset.uri); setAvatarMimeType(asset.mimeType ?? null) }
    } catch (reason) {
      if (reason instanceof ProfilePhotoPermissionError) {
        Alert.alert('사진 접근 권한이 필요해요', reason.canAskAgain ? '사진을 선택하려면 접근 권한을 다시 허용해 주세요.' : '휴대폰 설정에서 잉톡의 사진 접근 권한을 허용해 주세요.', [
          { text: '허용 안 함', style: 'cancel' },
          reason.canAskAgain
            ? { text: '다시 허용하기', onPress: () => void choosePhoto() }
            : { text: '설정 열기', onPress: () => void Linking.openSettings() },
        ])
      } else {
        Alert.alert('사진을 선택하지 못했어요', reason instanceof Error ? reason.message : '다시 시도해 주세요.')
      }
    }
  }

  const submit = async () => {
    if (!canSubmit || submitLockRef.current) return
    submitLockRef.current = true
    setSubmitting(true)
    setError('')

    try {
      if (!supabase) {
        const profile = { nickname: nickname.trim(), age: numericAge, gender: gender!, avatarUrl: avatarUri }
        localStorage.setItem('ingtalk.guest-profile.v1', JSON.stringify(profile))
        onComplete(profile)
        return
      }

      const userId = await getAccountId(supabase)
      if (!userId) throw new Error('verified_phone_required')

      const { data: profileBeforeInsert, error: profileLookupError } = await supabase
        .from('profiles').select('nickname, birth_year, gender, avatar_url').eq('id', userId).maybeSingle()
      if (profileLookupError) throw profileLookupError
      if (profileBeforeInsert) {
        onComplete({ nickname: profileBeforeInsert.nickname as string, age: new Date().getFullYear() - (profileBeforeInsert.birth_year as number), gender: profileBeforeInsert.gender as Gender, avatarUrl: profileBeforeInsert.avatar_url as string | null })
        return
      }

      const avatarUrl = avatarUri ? await uploadProfilePhoto(userId, avatarUri, avatarMimeType) : null

      const currentYear = new Date().getFullYear()
      const { error: profileError } = await supabase.from('profiles').insert({
        id: userId,
        nickname: nickname.trim(),
        birth_year: currentYear - numericAge,
        region_code: 'UNSET',
        gender,
        introduction: '',
        avatar_url: avatarUrl,
      })

      if (profileError?.code === '23505' || profileError?.message.includes('profiles_pkey')) {
        const { data: concurrentProfile, error: concurrentLookupError } = await supabase
          .from('profiles').select('nickname, birth_year, gender, avatar_url').eq('id', userId).single()
        if (concurrentLookupError) throw concurrentLookupError
        onComplete({ nickname: concurrentProfile.nickname as string, age: new Date().getFullYear() - (concurrentProfile.birth_year as number), gender: concurrentProfile.gender as Gender, avatarUrl: concurrentProfile.avatar_url as string | null })
        return
      }
      if (profileError) throw profileError
      const { error: rewardError } = await supabase.rpc('claim_account_welcome_points')
      if (rewardError) throw rewardError
      addAppBreadcrumb('guest_profile_created', { hasAvatar: Boolean(avatarUrl) })
      onComplete({ nickname: nickname.trim(), age: numericAge, gender: gender!, avatarUrl })
    } catch (reason) {
      captureAppError(reason, 'onboarding', 'create_guest_profile', { hasAvatar: Boolean(avatarUri) })
      const message = reason instanceof Error
        ? reason.message
        : typeof reason === 'object' && reason !== null && 'message' in reason
          ? String(reason.message)
          : '프로필을 저장하지 못했습니다.'
      if (message.includes('verified_phone_required')) {
        setError('전화번호와 기기 인증이 필요합니다. 다시 로그인해 주세요.')
      } else if (message.includes('gender') || message.includes('schema cache') || message.includes('PGRST204')) {
        setError('새 게스트 프로필 SQL 마이그레이션을 Supabase에 적용해 주세요.')
      } else {
        setError(message)
      }
    } finally {
      submitLockRef.current = false
      setSubmitting(false)
    }
  }

  if (checking) return <AppStartupScreen language={language} />
  if (profileLoadFailed) return <SafeAreaView style={styles.loading}>
    <Text style={styles.loadingText}>{language === 'ko' ? '기존 프로필을 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.' : 'Could not load your existing profile. Check your connection and try again.'}</Text>
    <Pressable accessibilityRole="button" onPress={() => setProfileRetry(value => value + 1)} style={{ padding: 18 }}><Text>{language === 'ko' ? '다시 불러오기' : 'Try again'}</Text></Pressable>
  </SafeAreaView>

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView
      testID="guest-profile-keyboard-viewport"
      style={styles.flex}
      enabled
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        overScrollMode="always"
      >
        <View style={styles.topRow}>
          {onBack ? <Pressable accessibilityRole="button" accessibilityLabel="언어 및 국가 선택으로 돌아가기" hitSlop={10} onPress={onBack} style={styles.backButton}><Text style={styles.backText}>‹ 이전</Text></Pressable> : <View style={styles.backButton} />}
          <Text style={styles.logo}>잉톡</Text>
          <View style={styles.backButton} />
        </View>
        <Text style={styles.title}>프로필을 알려주세요</Text>
        <Text style={styles.subtitle}>인증된 계정에 프로필을 등록하고 대화를 시작해 보세요.</Text>
        <View style={styles.adultNotice}><Text style={styles.adultNoticeTitle}>성인 전용 · 만 19세 이상</Text><Text style={styles.adultNoticeText}>미성년자는 가입하거나 이용할 수 없습니다.</Text></View>

        <Pressable style={styles.photoPicker} onPress={choosePhoto}>{avatarUri ? <Image source={{ uri: avatarUri }} style={styles.photo} /> : <View style={styles.photoPlaceholder}><Text style={styles.photoPlaceholderText}>사진</Text></View>}<Text style={styles.photoAction}>{avatarUri ? '사진 변경' : '프로필 사진 등록'}</Text></Pressable>

        <Text style={styles.label}>닉네임</Text>
        <TextInput value={nickname} onChangeText={setNickname} maxLength={9} placeholder="2~9자로 입력" placeholderTextColor="#A8A29E" autoCapitalize="none" returnKeyType="done" onSubmitEditing={() => { Keyboard.dismiss(); setAgePickerVisible(true) }} style={styles.input} />
        <Text style={styles.hint}>{nickname.length}/9</Text>

        <Text style={styles.label}>나이</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={age ? `선택된 나이 ${age}세` : '나이 선택'} onPress={() => { Keyboard.dismiss(); setAgePickerVisible(true) }} style={[styles.input, styles.ageSelector]}><Text style={age ? styles.ageValue : styles.agePlaceholder}>{age ? `${age}세` : '나이를 선택해 주세요'}</Text><Text style={styles.ageChevron}>⌄</Text></Pressable>
        <Text style={[styles.hint, age.length > 0 && !ageValid && styles.ageError]}>{age.length > 0 && numericAge < 19 ? '만 19세 미만은 이용할 수 없습니다.' : '19세 이상만 이용할 수 있어요.'}</Text>

        <Text style={styles.label}>성별</Text>
        <View style={styles.options}>{genders.map(item => <Pressable key={item.value} onPress={() => setGender(item.value)} style={[styles.option, gender === item.value && styles.optionActive]}><Text style={[styles.optionText, gender === item.value && styles.optionTextActive]}>{item.label}</Text></Pressable>)}</View>


        {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
        <Pressable disabled={!canSubmit} onPress={submit} style={[styles.button, !canSubmit && styles.buttonDisabled]}><Text style={styles.buttonText}>{submitting ? '프로필 만드는 중…' : '잉톡 시작하기'}</Text></Pressable>
        <Text style={styles.footnote}>{isSupabaseConfigured ? '임시 익명 ID로 안전하게 저장됩니다.' : '데모 모드에서는 이 기기에만 저장됩니다.'}</Text>
        {supabase && <AccountSwitchButton beforeProfile disabled={submitting} />}
      </ScrollView>
    </KeyboardAvoidingView>
    <AgePickerSheet visible={agePickerVisible} value={age ? Number(age) : null} onCancel={() => setAgePickerVisible(false)} onConfirm={nextAge => { setAge(String(nextAge)); setAgePickerVisible(false) }} />
  </SafeAreaView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, flex: { flex: 1 }, loading: { flex: 1, backgroundColor: '#FFF9F5', alignItems: 'center', justifyContent: 'center' }, loadingText: { color: '#78716C', fontSize: 13, marginTop: 12 },
  container: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 56 }, topRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, backButton: { width: 82, minHeight: 44, justifyContent: 'center' }, backText: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, logo: { color: '#F26B4B', fontSize: 18, fontWeight: '900', textAlign: 'center' }, title: { color: '#1F2937', fontSize: 28, lineHeight: 37, fontWeight: '900' }, subtitle: { color: '#78716C', fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 12 },
  adultNotice: { backgroundColor: '#FFF0E9', borderWidth: 1, borderColor: '#FFD1C2', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 4 }, adultNoticeTitle: { color: '#C2410C', fontSize: 13, fontWeight: '900' }, adultNoticeText: { color: '#78716C', fontSize: 11, marginTop: 3 },
  photoPicker: { alignItems: 'center', marginVertical: 12 }, photo: { width: 92, height: 92, borderRadius: 46 }, photoPlaceholder: { width: 92, height: 92, borderRadius: 46, backgroundColor: '#FFE0D5', alignItems: 'center', justifyContent: 'center' }, photoPlaceholderText: { color: '#C2410C', fontWeight: '900' }, photoAction: { color: '#F26B4B', fontSize: 12, fontWeight: '800', marginTop: 8 },
  label: { color: '#374151', fontSize: 14, fontWeight: '800', marginTop: 20, marginBottom: 9 }, input: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderRadius: 14, paddingHorizontal: 15, paddingVertical: 14, color: '#1F2937', fontSize: 15 }, hint: { color: '#A8A29E', fontSize: 11, marginTop: 6, alignSelf: 'flex-end' },
  ageError: { color: '#B91C1C', fontWeight: '700' },
  ageRow: { flexDirection: 'row', alignItems: 'center' }, ageSelector: { minHeight: 50, paddingVertical: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, ageValue: { color: '#1F2937', fontSize: 15, fontWeight: '800' }, agePlaceholder: { color: '#A8A29E', fontSize: 15 }, ageChevron: { color: '#A8A29E', fontSize: 20, fontWeight: '900' }, options: { flexDirection: 'row', gap: 8 }, option: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', alignItems: 'center' }, optionActive: { backgroundColor: '#F26B4B', borderColor: '#F26B4B' }, optionText: { color: '#78716C', fontSize: 13, fontWeight: '700' }, optionTextActive: { color: '#FFFFFF' },
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, marginTop: 18 }, errorText: { color: '#B91C1C', fontSize: 12, lineHeight: 18 }, button: { backgroundColor: '#F26B4B', borderRadius: 16, paddingVertical: 17, alignItems: 'center', marginTop: 24 }, buttonDisabled: { opacity: 0.35 }, buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' }, footnote: { color: '#A8A29E', fontSize: 11, textAlign: 'center', marginTop: 10 },
})

import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView,
  ScrollView, StyleSheet, View,
} from 'react-native'
import { Text, TextInput } from '../i18n/localizedUi'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { pickProfilePhoto, ProfilePhotoPermissionError, uploadProfilePhoto } from '../lib/profilePhoto'
import { DeviceIdentityUnavailableError, getDeviceRewardFingerprint } from '../lib/deviceIdentity'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { AgePickerSheet } from './AgePickerSheet'

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
  const scrollRef = useRef<ScrollView>(null)
  const submitLockRef = useRef(false)
  const [checking, setChecking] = useState(true)
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

    const findExistingProfile = async () => {
      if (!supabase) {
        const localProfile = localStorage.getItem('ingtalk.guest-profile.v1')
        if (localProfile) onComplete(JSON.parse(localProfile) as GuestProfile)
        else if (mounted) setChecking(false)
        return
      }

      const { data: sessionData } = await supabase.auth.getSession()
      let userId = sessionData.session?.user.id
      if (!userId) {
        const { data: anonymousData, error: anonymousError } = await supabase.auth.signInAnonymously()
        if (anonymousError) {
          captureAppError(anonymousError, 'onboarding', 'prepare_anonymous_recovery')
          if (mounted) setChecking(false)
          return
        }
        userId = anonymousData.user?.id
      }
      if (!userId) { if (mounted) setChecking(false); return }

      const deviceFingerprint = await getDeviceRewardFingerprint()
      const { data: recoveryData, error: recoveryError } = await supabase.rpc('restore_device_account', {
        device_fingerprint: deviceFingerprint,
      })
      if (recoveryError && !recoveryError.message.includes('Could not find the function')) {
        captureAppError(recoveryError, 'onboarding', 'restore_device_account')
      }

      const recovered = recoveryData as { recovered?: boolean; profile?: {
        nickname: string; birth_year: number; gender: Gender; avatar_url?: string | null
      } } | null
      if (recovered?.recovered && recovered.profile) {
        addAppBreadcrumb('anonymous_account_recovered', { chatWindowDays: 30 })
        onComplete({
          nickname: recovered.profile.nickname,
          age: new Date().getFullYear() - recovered.profile.birth_year,
          gender: recovered.profile.gender,
          avatarUrl: recovered.profile.avatar_url ?? null,
        })
        return
      }

      await supabase.rpc('refresh_my_suspension')
      const { data } = await supabase.from('profiles').select('nickname, birth_year, gender, avatar_url').eq('id', userId).maybeSingle()
      if (data) {
        await supabase.rpc('claim_device_welcome_points', { device_fingerprint: deviceFingerprint })
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
      captureAppError(reason, 'onboarding', 'prepare_device_identity')
      if (mounted) setChecking(false)
    })
    return () => { mounted = false }
  }, [onComplete])

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

      const { data: existing } = await supabase.auth.getSession()
      let userId = existing.session?.user.id

      if (!userId) {
        const { data, error: authError } = await supabase.auth.signInAnonymously()
        if (authError) throw authError
        userId = data.user?.id
      }

      if (!userId) throw new Error('익명 사용자 ID를 만들지 못했습니다.')

      const deviceFingerprint = await getDeviceRewardFingerprint()
      const { data: recoveryData, error: recoveryError } = await supabase.rpc('restore_device_account', {
        device_fingerprint: deviceFingerprint,
      })
      if (recoveryError && !recoveryError.message.includes('Could not find the function')) throw recoveryError
      const recovered = recoveryData as { recovered?: boolean; profile?: { nickname: string; birth_year: number; gender: Gender; avatar_url?: string | null } } | null
      if (recovered?.recovered && recovered.profile) {
        onComplete({ nickname: recovered.profile.nickname, age: new Date().getFullYear() - recovered.profile.birth_year, gender: recovered.profile.gender, avatarUrl: recovered.profile.avatar_url ?? null })
        return
      }

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
      const { error: rewardError } = await supabase.rpc('claim_device_welcome_points', { device_fingerprint: deviceFingerprint })
      if (rewardError?.message.includes('device_account_recovery_required')) {
        const { data: retryData, error: retryError } = await supabase.rpc('restore_device_account', { device_fingerprint: deviceFingerprint })
        if (retryError) throw retryError
        const retry = retryData as { recovered?: boolean; profile?: { nickname: string; birth_year: number; gender: Gender; avatar_url?: string | null } } | null
        if (retry?.recovered && retry.profile) {
          onComplete({ nickname: retry.profile.nickname, age: new Date().getFullYear() - retry.profile.birth_year, gender: retry.profile.gender, avatarUrl: retry.profile.avatar_url ?? null })
          return
        }
      }
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
      if (reason instanceof DeviceIdentityUnavailableError || message.includes('device_identity_unavailable')) {
        setError('기기 정보를 안전하게 확인하지 못했습니다. 휴대폰을 다시 시작한 뒤 시도해 주세요.')
      } else if (message.toLowerCase().includes('anonymous sign-ins are disabled')) {
        setError('Supabase에서 익명 로그인을 먼저 활성화해 주세요.')
      } else if (message.includes('gender') || message.includes('schema cache') || message.includes('PGRST204')) {
        setError('새 게스트 프로필 SQL 마이그레이션을 Supabase에 적용해 주세요.')
      } else if (message.includes('device_account_recovery_required')) {
        setError('이 기기의 이전 계정을 복구하지 못했습니다. 앱을 다시 실행한 뒤 시도해 주세요.')
      } else {
        setError(message)
      }
    } finally {
      submitLockRef.current = false
      setSubmitting(false)
    }
  }

  if (checking) return <SafeAreaView style={styles.loading}><ActivityIndicator color="#F26B4B" /><Text style={styles.loadingText}>프로필을 확인하고 있어요</Text></SafeAreaView>

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        <Text style={styles.subtitle}>회원가입 없이 이 프로필로 바로 대화를 시작할 수 있어요.</Text>
        <View style={styles.adultNotice}><Text style={styles.adultNoticeTitle}>성인 전용 · 만 19세 이상</Text><Text style={styles.adultNoticeText}>미성년자는 가입하거나 이용할 수 없습니다.</Text></View>

        <Pressable style={styles.photoPicker} onPress={choosePhoto}>{avatarUri ? <Image source={{ uri: avatarUri }} style={styles.photo} /> : <View style={styles.photoPlaceholder}><Text style={styles.photoPlaceholderText}>사진</Text></View>}<Text style={styles.photoAction}>{avatarUri ? '사진 변경' : '프로필 사진 등록'}</Text></Pressable>

        <Text style={styles.label}>닉네임</Text>
        <TextInput value={nickname} onChangeText={setNickname} maxLength={9} placeholder="2~9자로 입력" placeholderTextColor="#A8A29E" autoCapitalize="none" returnKeyType="done" onFocus={() => setTimeout(() => scrollRef.current?.scrollTo({ y: 330, animated: true }), 120)} onSubmitEditing={() => { Keyboard.dismiss(); setAgePickerVisible(true) }} style={styles.input} />
        <Text style={styles.hint}>{nickname.length}/9</Text>

        <Text style={styles.label}>나이</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={age ? `선택된 나이 ${age}세` : '나이 선택'} onPress={() => { Keyboard.dismiss(); setAgePickerVisible(true) }} style={[styles.input, styles.ageSelector]}><Text style={age ? styles.ageValue : styles.agePlaceholder}>{age ? `${age}세` : '나이를 선택해 주세요'}</Text><Text style={styles.ageChevron}>⌄</Text></Pressable>
        <Text style={[styles.hint, age.length > 0 && !ageValid && styles.ageError]}>{age.length > 0 && numericAge < 19 ? '만 19세 미만은 이용할 수 없습니다.' : '19세 이상만 이용할 수 있어요.'}</Text>

        <Text style={styles.label}>성별</Text>
        <View style={styles.options}>{genders.map(item => <Pressable key={item.value} onPress={() => setGender(item.value)} style={[styles.option, gender === item.value && styles.optionActive]}><Text style={[styles.optionText, gender === item.value && styles.optionTextActive]}>{item.label}</Text></Pressable>)}</View>


        {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
        <Pressable disabled={!canSubmit} onPress={submit} style={[styles.button, !canSubmit && styles.buttonDisabled]}><Text style={styles.buttonText}>{submitting ? '프로필 만드는 중…' : '잉톡 시작하기'}</Text></Pressable>
        <Text style={styles.footnote}>{isSupabaseConfigured ? '임시 익명 ID로 안전하게 저장됩니다.' : '데모 모드에서는 이 기기에만 저장됩니다.'}</Text>
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

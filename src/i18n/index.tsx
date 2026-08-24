import * as SecureStore from 'expo-secure-store'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import { getDeviceRewardFingerprint } from '../lib/deviceIdentity'
import { supabase } from '../lib/supabase'
import { localizeText, setLocalizedUiLanguage } from './localizedUi'

export type AppLanguage = 'ko' | 'en'
export type ServiceCountry = 'KR' | 'US' | 'JP' | 'GB' | 'CA' | 'AU' | 'DE' | 'FR' | 'SG' | 'OTHER'

export const serviceCountries: Array<{ code: ServiceCountry; ko: string; en: string; timeZone: string }> = [
  { code: 'KR', ko: '대한민국', en: 'South Korea', timeZone: 'Asia/Seoul' }, { code: 'US', ko: '미국', en: 'United States', timeZone: 'America/New_York' },
  { code: 'JP', ko: '일본', en: 'Japan', timeZone: 'Asia/Tokyo' }, { code: 'GB', ko: '영국', en: 'United Kingdom', timeZone: 'Europe/London' },
  { code: 'CA', ko: '캐나다', en: 'Canada', timeZone: 'America/Toronto' }, { code: 'AU', ko: '호주', en: 'Australia', timeZone: 'Australia/Sydney' },
  { code: 'DE', ko: '독일', en: 'Germany', timeZone: 'Europe/Berlin' }, { code: 'FR', ko: '프랑스', en: 'France', timeZone: 'Europe/Paris' },
  { code: 'SG', ko: '싱가포르', en: 'Singapore', timeZone: 'Asia/Singapore' }, { code: 'OTHER', ko: '기타 지역', en: 'Other region', timeZone: 'UTC' },
]

export type RegionalPreferences = {
  language: AppLanguage
  country: ServiceCountry
}

type Messages = typeof ko
type MessageKey = keyof Messages

const ko = {
  chooseRegionTitle: '언어와 국가를 선택해 주세요',
  chooseRegionDescription: '언어와 국가는 나중에 내 정보에서 변경할 수 있어요.',
  language: '언어', country: '서비스 국가', korean: '한국어', english: 'English', korea: '대한민국', unitedStates: '미국', otherRegions: '기타 지역',
  continue: '계속하기', regionalSettings: '언어 및 국가', regionalSettingsDescription: '화면 언어와 서비스 지역을 관리해요',
  regionalSettingsTitle: '언어 및 국가 설정', save: '저장', close: '닫기', saved: '설정 완료', savedDescription: '언어와 국가 설정을 적용했습니다.',
  discover: '발견', discoverSubtitle: '오늘도 좋은 대화를 이어가요', board: '게시판', chats: '대화', myInfo: '내 정보',
  myProfile: '내 프로필', profileSubtitle: '나만의 프로필과 권한을 편리하게 관리해요', editProfile: '프로필 수정',
  points: '포인트', pointsDescription: '대화 신청 시 100P를 사용해요', charge: '충전하기',
  refreshDiscovery: '발견 목록 새로고침', writeTalk: '+톡쓰기', all: '전체', region: '지역', neighborhood: '동네', nearby: '근처', myTalk: '내톡',
  termsAndPrivacy: '이용약관 및 개인정보', termsAndPrivacyDescription: '서비스 이용약관과 개인정보처리방침을 확인해요',
  support: '고객센터 문의', supportDescription: '이용 중 궁금한 점을 운영자에게 문의하세요', contact: '문의하기',
} as const

const en: Record<MessageKey, string> = {
  chooseRegionTitle: 'Choose your language and country',
  chooseRegionDescription: 'Change these later in My Info.',
  language: 'Language', country: 'Service country', korean: '한국어', english: 'English', korea: 'South Korea', unitedStates: 'United States', otherRegions: 'Other regions',
  continue: 'Continue', regionalSettings: 'Language & Country', regionalSettingsDescription: 'Manage your display language and service region',
  regionalSettingsTitle: 'Language & Country', save: 'Save', close: 'Close', saved: 'Settings updated', savedDescription: 'Your language and country settings have been applied.',
  discover: 'Discover', discoverSubtitle: 'Keep the good conversations going', board: 'Board', chats: 'Chats', myInfo: 'My Info',
  myProfile: 'My Profile', profileSubtitle: 'Manage your profile and permissions', editProfile: 'Edit profile',
  points: 'Points', pointsDescription: 'Chat requests cost 100P', charge: 'Add points',
  refreshDiscovery: 'Refresh discovery', writeTalk: '+ New', all: 'All', region: 'Region', neighborhood: 'Local', nearby: 'Nearby', myTalk: 'Mine',
  termsAndPrivacy: 'Terms & Privacy', termsAndPrivacyDescription: 'Review the Terms of Service and Privacy Policy',
  support: 'Customer Support', supportDescription: 'Ask our team for help with the service', contact: 'Contact us',
}

const STORAGE_KEY = 'ingtalk.regional-preferences.v1'
const INSTALLATION_READY_KEY = 'ingtalk.installation-ready.v1'

type I18nContextValue = RegionalPreferences & {
  ready: boolean
  hasSelected: boolean
  isRecoveryConfirmation: boolean
  locale: 'ko-KR' | 'en-US'
  t: (key: MessageKey) => string
  updatePreferences: (next: RegionalPreferences) => Promise<void>
}

const I18nContext = createContext<I18nContextValue>({
  language: 'ko', country: 'KR', ready: true, hasSelected: true, isRecoveryConfirmation: false, locale: 'ko-KR',
  t: key => ko[key],
  updatePreferences: async () => {},
})

function isPreferences(value: unknown): value is RegionalPreferences {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RegionalPreferences>
  return (item.language === 'ko' || item.language === 'en') && serviceCountries.some(country => country.code === item.country)
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<RegionalPreferences>({ language: 'ko', country: 'KR' })
  const [ready, setReady] = useState(false)
  const [hasSelected, setHasSelected] = useState(false)
  const [isRecoveryConfirmation, setIsRecoveryConfirmation] = useState(false)
  setLocalizedUiLanguage(preferences.language, preferences.country)

  useEffect(() => {
    void (async () => {
      const saved = await SecureStore.getItemAsync(STORAGE_KEY)
      let savedPreferences: RegionalPreferences | null = null
      if (saved) {
        try {
          const parsed: unknown = JSON.parse(saved)
          if (isPreferences(parsed)) savedPreferences = parsed
        } catch { /* Ignore corrupt preferences. */ }
      }

      const installationMarkerExists = localStorage.getItem(INSTALLATION_READY_KEY) === '1'
      localStorage.setItem(INSTALLATION_READY_KEY, '1')
      if (installationMarkerExists) {
        if (savedPreferences) { setPreferences(savedPreferences); setHasSelected(true) }
        return
      }

      if (supabase) {
        const { data: existingSession } = await supabase.auth.getSession()
        // A session on an installation without the new marker is an app upgrade,
        // not a reinstall. Do not interrupt an existing user merely once.
        if (existingSession.session?.user.id) {
          const { data: profile } = await supabase.from('profiles').select('language_code, country_code').eq('id', existingSession.session.user.id).maybeSingle()
          const serverPreferences = { language: profile?.language_code, country: profile?.country_code }
          const restored = isPreferences(serverPreferences) ? serverPreferences : savedPreferences
          if (restored) { setPreferences(restored); setHasSelected(true); await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(restored)) }
          return
        }

        const { data: anonymous } = await supabase.auth.signInAnonymously()
        const userId = anonymous.user?.id
        if (userId) {
          const deviceFingerprint = await getDeviceRewardFingerprint()
          const { data: recovery } = await supabase.rpc('restore_device_account', { device_fingerprint: deviceFingerprint })
          if ((recovery as { recovered?: boolean } | null)?.recovered) {
            const { data: profile } = await supabase.from('profiles').select('language_code, country_code').eq('id', userId).maybeSingle()
            const serverPreferences = { language: profile?.language_code, country: profile?.country_code }
            const restored = isPreferences(serverPreferences) ? serverPreferences : savedPreferences
            if (restored) {
              setPreferences(restored)
              setIsRecoveryConfirmation(true)
              await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(restored))
              return
            }
          }
        }
      }

      // Brand-new installations still show the normal selector. A Keychain value
      // surviving iOS uninstall may be used only as a convenient initial choice.
      if (savedPreferences) setPreferences(savedPreferences)
    })().catch(() => {
      // Device recovery is best-effort here. Native onboarding reports a clear
      // error before any welcome points or profile rows can be created.
    }).finally(() => setReady(true))
  }, [])

  useEffect(() => {
    setLocalizedUiLanguage(preferences.language, preferences.country)
    const nativeAlert = Alert.alert
    Alert.alert = ((title, message, buttons, options) => {
      const localizedTitle = localizeText(title)
      const localizedMessage = message == null ? message : localizeText(message)
      if (preferences.language === 'en' && typeof __DEV__ !== 'undefined' && __DEV__) {
        if (/[가-힣]/.test(localizedTitle) || (localizedMessage && /[가-힣]/.test(localizedMessage))) console.warn('[i18n] Untranslated alert:', title, message)
      }
      return nativeAlert(
      localizedTitle,
      localizedMessage,
      buttons?.map(button => ({ ...button, text: button.text ? localizeText(button.text) : button.text })),
      options,
    )}) as typeof Alert.alert
    return () => { Alert.alert = nativeAlert }
  }, [preferences.language, preferences.country])

  const updatePreferences = useCallback(async (next: RegionalPreferences) => {
    setPreferences(next)
    setHasSelected(true)
    setIsRecoveryConfirmation(false)
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next))
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      if (data.session?.user.id) {
        const { error } = await supabase.rpc('update_my_regional_preferences', {
          next_language: next.language,
          next_country: next.country,
        })
        if (error && !error.message.includes('function') && !error.message.includes('schema cache')) console.warn('Regional preferences were saved locally but not synced.', error.message)
      }
    }
  }, [])

  const value = useMemo<I18nContextValue>(() => ({
    ...preferences,
    ready,
    hasSelected,
    isRecoveryConfirmation,
    locale: preferences.language === 'ko' ? 'ko-KR' : 'en-US',
    t: key => (preferences.language === 'ko' ? ko[key] : en[key]),
    updatePreferences,
  }), [preferences, ready, hasSelected, isRecoveryConfirmation, updatePreferences])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export function formatNumber(value: number, language: AppLanguage, _country?: ServiceCountry) {
  return new Intl.NumberFormat(language === 'ko' ? 'ko-KR' : 'en-US').format(value)
}

export function formatDateTime(value: string | number | Date, language: AppLanguage, country: ServiceCountry, includeYear = false) {
  const timeZone = serviceCountries.find(item => item.code === country)?.timeZone ?? 'UTC'
  return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    ...(includeYear ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone,
  }).format(new Date(value))
}

export function formatTime(value: string | number | Date, language: AppLanguage, country: ServiceCountry) {
  const timeZone = serviceCountries.find(item => item.code === country)?.timeZone ?? 'UTC'
  return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(value))
}

export function formatDate(value: string | number | Date, language: AppLanguage, country: ServiceCountry) {
  const timeZone = serviceCountries.find(item => item.code === country)?.timeZone ?? 'UTC'
  return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone }).format(new Date(value))
}

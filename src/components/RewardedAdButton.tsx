import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native'
import mobileAds, {
  AdEventType,
  RewardedAd,
  RewardedAdEventType,
  TestIds,
} from 'react-native-google-mobile-ads'
import { captureAppError } from '../lib/observability'
import { supabase } from '../lib/supabase'

const productionAdUnitId = 'ca-app-pub-2857738057928315/6544344118'
const statusPollAttempts = 12
const statusPollIntervalMs = 2_000

type ButtonState = 'checking' | 'loading' | 'ready' | 'showing' | 'verifying' | 'cooldown' | 'error'

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export function RewardedAdButton({ language, onBalanceChanged }: {
  language: 'ko' | 'en'
  onBalanceChanged: (balance: number) => void
}) {
  const [state, setState] = useState<ButtonState>('checking')
  const rewardedRef = useRef<RewardedAd | null>(null)
  const mountedRef = useRef(true)
  const earnedRef = useRef(false)

  const readRewardStatus = useCallback(async () => {
    if (!supabase) return { available: false, balance: 0 }
    const [statusResult, balanceResult] = await Promise.all([
      supabase.rpc('my_rewarded_ad_status'),
      supabase.rpc('my_point_balance'),
    ])
    if (statusResult.error) throw statusResult.error
    if (balanceResult.error) throw balanceResult.error
    return {
      available: Boolean(statusResult.data?.[0]?.available),
      balance: Number(balanceResult.data ?? 0),
    }
  }, [])

  const pollForVerifiedReward = useCallback(async () => {
    if (__DEV__) {
      if (mountedRef.current) setState('ready')
      Alert.alert(
        language === 'ko' ? '테스트 광고 완료' : 'Test ad completed',
        language === 'ko'
          ? '로컬 개발용 샘플 광고에서는 포인트를 지급하지 않습니다. Play 비공개 테스트 빌드에서는 Google 서버 확인 후 50P가 지급됩니다.'
          : 'Local sample ads do not grant points. Play closed-test builds grant 50P after Google server verification.',
      )
      return
    }
    if (mountedRef.current) setState('verifying')
    for (let attempt = 0; attempt < statusPollAttempts; attempt += 1) {
      try {
        const result = await readRewardStatus()
        if (!result.available) {
          onBalanceChanged(result.balance)
          if (mountedRef.current) setState('cooldown')
          Alert.alert(
            language === 'ko' ? '광고 보상 완료' : 'Ad reward complete',
            language === 'ko' ? '광고 시청 보상 50P가 충전되었습니다.' : 'Your 50P ad reward has been added.',
          )
          return
        }
      } catch (error) {
        captureAppError(error, 'points', 'poll_rewarded_ad')
      }
      await wait(statusPollIntervalMs)
    }
    if (mountedRef.current) setState('error')
    Alert.alert(
      language === 'ko' ? '보상 확인 지연' : 'Reward verification delayed',
      language === 'ko'
        ? '광고 시청은 완료됐지만 서버 확인이 지연되고 있습니다. 잠시 후 내 정보를 다시 열어 포인트를 확인해 주세요.'
        : 'The ad was completed, but server verification is delayed. Reopen My Info shortly to check your points.',
    )
  }, [language, onBalanceChanged, readRewardStatus])

  const prepareAd = useCallback(async () => {
    if (!supabase || Platform.OS !== 'android') {
      if (mountedRef.current) setState('error')
      return
    }
    try {
      const status = await readRewardStatus()
      onBalanceChanged(status.balance)
      if (!status.available) {
        if (mountedRef.current) setState('cooldown')
        return
      }
      const { data: userResult, error: userError } = await supabase.auth.getUser()
      if (userError) throw userError
      const userId = userResult.user?.id
      if (!userId) throw new Error('signed_in_user_required')

      if (mountedRef.current) setState('loading')
      await mobileAds().initialize()
      rewardedRef.current?.removeAllListeners()
      const rewarded = RewardedAd.createForAdRequest(__DEV__ ? TestIds.REWARDED : productionAdUnitId, {
        requestNonPersonalizedAdsOnly: true,
        serverSideVerificationOptions: { userId, customData: 'ingtalk_rewarded_50' },
      })
      rewardedRef.current = rewarded
      earnedRef.current = false

      rewarded.addAdEventListener(RewardedAdEventType.LOADED, () => {
        if (mountedRef.current) setState('ready')
      })
      rewarded.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        earnedRef.current = true
        void pollForVerifiedReward()
      })
      rewarded.addAdEventListener(AdEventType.CLOSED, () => {
        if (!earnedRef.current && mountedRef.current) {
          setState('loading')
          rewarded.removeAllListeners()
          rewardedRef.current = null
          void prepareAd()
        }
      })
      rewarded.addAdEventListener(AdEventType.ERROR, error => {
        captureAppError(error, 'ads', 'rewarded_ad')
        if (mountedRef.current) setState('error')
      })
      rewarded.load()
    } catch (error) {
      captureAppError(error, 'ads', 'prepare_rewarded_ad')
      if (mountedRef.current) setState('error')
    }
  }, [onBalanceChanged, pollForVerifiedReward, readRewardStatus])

  useEffect(() => {
    mountedRef.current = true
    void prepareAd()
    return () => {
      mountedRef.current = false
      rewardedRef.current?.removeAllListeners()
      rewardedRef.current = null
    }
  }, [prepareAd])

  const press = async () => {
    if (state === 'error') {
      await prepareAd()
      return
    }
    if (state !== 'ready' || !rewardedRef.current) return
    setState('showing')
    try {
      await rewardedRef.current.show()
    } catch (error) {
      captureAppError(error, 'ads', 'show_rewarded_ad')
      setState('error')
    }
  }

  const labels: Record<ButtonState, string> = language === 'ko'
    ? { checking: '광고 상태 확인 중…', loading: '광고 불러오는 중…', ready: '광고 시청 · +50P', showing: '광고 시청 중…', verifying: '보상 확인 중…', cooldown: '광고 완료 · 24시간 후', error: '광고 다시 불러오기' }
    : { checking: 'Checking ad…', loading: 'Loading ad…', ready: 'Watch ad · +50P', showing: 'Ad playing…', verifying: 'Verifying reward…', cooldown: 'Ad complete · 24h', error: 'Reload ad' }
  const disabled = !['ready', 'error'].includes(state)

  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={language === 'ko' ? '광고 시청으로 50포인트 받기' : 'Watch an ad for 50 points'}
    disabled={disabled}
    onPress={() => void press()}
    style={[styles.button, disabled && styles.disabled]}
  >
    <Text style={styles.icon}>▶</Text>
    <Text numberOfLines={2} style={styles.text}>{labels[state]}</Text>
  </Pressable>
}

const styles = StyleSheet.create({
  button: { flex: 1, minWidth: 0, minHeight: 46, borderRadius: 12, paddingHorizontal: 8, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D7CCF5', backgroundColor: '#F4F0FF' },
  disabled: { opacity: 0.58 },
  icon: { color: '#7257B7', fontSize: 12, lineHeight: 15, fontWeight: '900' },
  text: { color: '#5B3E9B', fontSize: 10, lineHeight: 14, fontWeight: '900', textAlign: 'center' },
})

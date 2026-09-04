import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { initializeMobileAds } from '../lib/mobileAds'
import { supabase } from '../lib/supabase'

const productionAdUnitId = 'ca-app-pub-2857738057928315/6544344118'
const statusPollAttempts = 10
const statusPollIntervalMs = 2_000
const adLoadTimeoutMs = 30_000
const closeEventGraceMs = 250
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient
const adsSupported = Platform.OS === 'android' && !isExpoGo
const appEnvironment = process.env.EXPO_PUBLIC_APP_ENV?.trim().toLowerCase()

type ButtonState = 'checking' | 'loading' | 'ready' | 'showing' | 'verifying' | 'verification_error' | 'cooldown' | 'error'
type ErrorContext = Record<string, string | number | boolean | null | undefined>

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const summarizeError = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return 'unknown_error'
}
const isNoFillError = (error: unknown) => /no[\s_-]?fill/i.test(summarizeError(error))
const rewardedAdErrorContext = (error: unknown): ErrorContext => {
  if (typeof error !== 'object' || error === null) return { errorSummary: summarizeError(error) }
  const sdkError = error as {
    code?: unknown
    domain?: unknown
    namespace?: unknown
    cause?: unknown
    userInfo?: { code?: unknown }
  }
  return {
    errorCode: typeof sdkError.code === 'string' ? sdkError.code : undefined,
    nativeErrorCode: typeof sdkError.userInfo?.code === 'string' ? sdkError.userInfo.code : undefined,
    errorDomain: typeof sdkError.domain === 'string'
      ? sdkError.domain
      : typeof sdkError.namespace === 'string' ? sdkError.namespace : undefined,
    errorSummary: summarizeError(error),
    causeSummary: sdkError.cause == null ? undefined : summarizeError(sdkError.cause),
  }
}

export function RewardedAdButton({ language, onBalanceChanged }: {
  language: 'ko' | 'en'
  onBalanceChanged: (balance: number) => void
}) {
  const [state, setState] = useState<ButtonState>('checking')
  const useTestAd = __DEV__ || appEnvironment === 'development' || appEnvironment === 'preview'
  const stateRef = useRef<ButtonState>('checking')
  const rewardedRef = useRef<import('react-native-google-mobile-ads').RewardedAd | null>(null)
  const mountedRef = useRef(true)
  const earnedRef = useRef(false)
  const lastBalanceRef = useRef(0)
  const claimTokenRef = useRef<string | null>(null)
  const verificationTokenRef = useRef<string | null>(null)
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const adGenerationRef = useRef(0)
  const rewardSettlementRef = useRef<Promise<void> | null>(null)
  const prepareAdRef = useRef<(recover?: boolean) => Promise<void>>(async () => {})

  const transitionTo = useCallback((nextState: ButtonState) => {
    stateRef.current = nextState
    setState(nextState)
  }, [])

  const trace = useCallback((event: string, context: ErrorContext = {}) => {
    const payload: ErrorContext = { event, ...context, state: stateRef.current, language }
    const summary = `adflow:${event}`
    if (__DEV__) console.log(`[RewardedAdButton] ${summary}`, payload)
    addAppBreadcrumb(summary, payload)
  }, [language])

  const setErrorState = useCallback((reason: string, context: ErrorContext = {}) => {
    trace('error_state', { reason, ...context })
    transitionTo('error')
    captureAppError(context.error || reason, 'ads', 'rewarded_ad_state', { reason, ...context })
  }, [trace, transitionTo])

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
    loadTimeoutRef.current = null
  }, [])

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
    closeTimeoutRef.current = null
  }, [])

  const cancelRewardClaim = useCallback(async (claimToken: string, reason: string) => {
    if (!supabase) return
    const result = await supabase.rpc('cancel_rewarded_ad_claim', { claim_token: claimToken })
    addAppBreadcrumb('adflow:claim_cancelled', { reason, cancelled: result.data === true })
    if (result.error) captureAppError(result.error, 'ads', 'cancel_rewarded_ad_claim', { reason })
  }, [])

  const readRewardStatus = useCallback(async () => {
    trace('read_reward_status.start')
    if (!supabase) return { available: false, balance: 0 }
    const [statusResult, balanceResult] = await Promise.all([
      supabase.rpc('my_rewarded_ad_status'),
      supabase.rpc('my_point_balance'),
    ])
    if (statusResult.error) throw statusResult.error
    if (balanceResult.error) throw balanceResult.error
    const balance = Number(balanceResult.data ?? 0)
    lastBalanceRef.current = balance
    trace('read_reward_status.done', { available: statusResult.data?.[0]?.available, balance })
    return {
      available: Boolean(statusResult.data?.[0]?.available),
      balance,
    }
  }, [trace])

  const requestRewardClaim = useCallback(async (recover = false) => {
    trace('request_claim.start', { recover })
    if (!supabase) return null
    if (!recover) {
      const prepared = await supabase.rpc('prepare_rewarded_ad_claim')
      trace('request_claim.done', { recover, source: 'prepare_rewarded_ad_claim' })
      return prepared
    }
    try {
      const resetResult = await supabase.rpc('reset_rewarded_ad_claim')
      if (!resetResult.error) return resetResult
      trace('request_claim.reset_failed', { recover, code: resetResult.error.code ?? '', message: summarizeError(resetResult.error) })
      captureAppError(resetResult.error, 'ads', 'reset_rewarded_ad_claim')
    } catch (error) {
      trace('request_claim.reset_exception', { recover, message: summarizeError(error) })
      captureAppError(error, 'ads', 'reset_rewarded_ad_claim')
    }
    const prepared = await supabase.rpc('prepare_rewarded_ad_claim')
    trace('request_claim.done', { recover, source: 'prepare_rewarded_ad_claim_fallback' })
    return prepared
  }, [trace])

  const pollForVerifiedReward = useCallback(async (claimToken: string) => {
    trace('poll.start')
    if (useTestAd) {
      await cancelRewardClaim(claimToken, 'development_test_ad')
      if (verificationTokenRef.current === claimToken) verificationTokenRef.current = null
      if (mountedRef.current) transitionTo('ready')
      Alert.alert(
        language === 'ko' ? '테스트 광고 완료' : 'Test ad completed',
        language === 'ko'
          ? '로컬 개발용 샘플 광고에서는 포인트를 지급하지 않습니다. Play 비공개 테스트 빌드에서는 Google 서버 확인 후 50P가 지급됩니다.'
          : 'Local sample ads do not grant points. Play closed-test builds grant 50P after Google server verification.',
      )
      return
    }
    if (mountedRef.current) transitionTo('verifying')
    for (let attempt = 0; attempt < statusPollAttempts; attempt += 1) {
      if (!mountedRef.current) return
      try {
        const receipt = await supabase!.rpc('my_rewarded_ad_claim_status', { claim_token: claimToken })
        if (receipt.error) throw receipt.error
        trace('poll.attempt', { attempt, receipt: receipt.data })
        if (receipt.data === 'awarded' || receipt.data === 'denied') {
          const result = await readRewardStatus()
          if (!mountedRef.current) return
          onBalanceChanged(result.balance)
          if (mountedRef.current) transitionTo('cooldown')
          if (verificationTokenRef.current === claimToken) verificationTokenRef.current = null
          Alert.alert(
            language === 'ko' ? '광고 보상 확인' : 'Ad reward checked',
            receipt.data === 'awarded'
            ? (language === 'ko' ? '광고 시청 보상 50P가 충전되었습니다.' : 'Your 50P ad reward has been added.')
            : (language === 'ko' ? '이 계정 또는 기기에서 이미 광고 보상을 받았어요. 마지막 수령 후 24시간이 지나면 다시 받을 수 있습니다.' : 'This account or device already received the ad reward. Try again 24 hours after the last reward.'),
          )
          trace('poll.done', { final: receipt.data, balance: result.balance })
          return
        }
        if (receipt.data === 'expired' || receipt.data === 'unavailable') break
      } catch (error) {
        trace('poll.error', { attempt, message: summarizeError(error) })
        captureAppError(error, 'points', 'poll_rewarded_ad')
      }
      await wait(statusPollIntervalMs)
    }
    if (!mountedRef.current) return
    try {
      const previousBalance = lastBalanceRef.current
      const result = await readRewardStatus()
      if (!mountedRef.current) return
      if (!result.available && result.balance > previousBalance) {
        onBalanceChanged(result.balance)
        trace('poll.late_success', { balance: result.balance })
        transitionTo('cooldown')
        if (verificationTokenRef.current === claimToken) verificationTokenRef.current = null
        Alert.alert(
          language === 'ko' ? '광고 보상 확인' : 'Ad reward checked',
          language === 'ko'
            ? '광고 시청 보상 50P가 충전되었습니다.'
            : 'Your 50P ad reward has been added.',
        )
        return
      }
    } catch (error) {
      trace('poll.late_error', { message: summarizeError(error) })
      captureAppError(error, 'points', 'poll_rewarded_ad_late')
    }
    trace('poll.timeout')
    transitionTo('verification_error')
    addAppBreadcrumb('adflow:verification_delayed', { retryable: true })
    Alert.alert(
      language === 'ko' ? '보상 확인 지연' : 'Reward verification delayed',
      language === 'ko'
        ? '광고 시청은 완료됐지만 서버 확인이 지연되고 있습니다. 잠시 후 내 정보를 다시 열어 포인트를 확인해 주세요.'
        : 'The ad was completed, but server verification is delayed. Reopen My Info shortly to check your points.',
    )
  }, [cancelRewardClaim, language, onBalanceChanged, readRewardStatus, trace, transitionTo, useTestAd])

  const prepareAd = useCallback(async (recover = false) => {
    const generation = ++adGenerationRef.current
    trace('prepare_ad.start', { recover, generation })
    if (!supabase || !adsSupported) {
      setErrorState('ads_unsupported', { adsSupported, platform: Platform.OS })
      return
    }
    let preparedToken: string | null = null
    try {
      if (mountedRef.current) transitionTo('checking')
      clearLoadTimeout()
      clearCloseTimeout()
      rewardedRef.current?.removeAllListeners()
      rewardedRef.current = null
      earnedRef.current = false
      rewardSettlementRef.current = null
      // Expo Go has no RNGoogleMobileAdsModule. Resolve the package only after
      // confirming that this is a native Android build containing the module.
      const {
        AdEventType,
        RewardedAd,
        RewardedAdEventType,
        TestIds,
      } = require('react-native-google-mobile-ads') as typeof import('react-native-google-mobile-ads')
      const status = await readRewardStatus()
      if (!mountedRef.current || adGenerationRef.current !== generation) return
      trace('prepare_ad.status', { recover, available: status.available, balance: status.balance })
      onBalanceChanged(status.balance)
      if (!status.available) {
        if (mountedRef.current) transitionTo('cooldown')
        trace('prepare_ad.cooldown', { available: false, next: status.balance })
        return
      }
      const claim = await requestRewardClaim(recover)
      if (!mountedRef.current || adGenerationRef.current !== generation) return
      if (!claim) throw new Error('rewarded_ad_claim_unavailable')
      if (claim.error) throw claim.error
      trace('prepare_ad.claim', { recover, available: claim.data?.available })
      if (!claim.data?.available) {
        if (mountedRef.current) transitionTo('cooldown')
        trace('prepare_ad.claim_unavailable', { available: false })
        return
      }
      const { token, user_id: userId, custom_data: customData } = claim.data
      if (!token || !userId || !customData) {
        throw new Error('rewarded_ad_claim_required')
      }
      preparedToken = token
      claimTokenRef.current = token

      if (mountedRef.current) transitionTo('loading')
      await initializeMobileAds()
      if (!mountedRef.current || adGenerationRef.current !== generation) {
        if (claimTokenRef.current === token) {
          claimTokenRef.current = null
          void cancelRewardClaim(token, 'stale_prepare')
        }
        return
      }
      const rewarded = RewardedAd.createForAdRequest(useTestAd ? TestIds.REWARDED : productionAdUnitId, {
        requestNonPersonalizedAdsOnly: true,
        serverSideVerificationOptions: { userId, customData },
      })
      rewardedRef.current = rewarded
      earnedRef.current = false

      rewarded.addAdEventListener(RewardedAdEventType.LOADED, () => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
        clearLoadTimeout()
        trace('ad_event.loaded', { generation })
        transitionTo('ready')
      })
      rewarded.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
        if (earnedRef.current) {
          trace('ad_event.earned_duplicate_ignored', { generation })
          return
        }
        clearLoadTimeout()
        trace('ad_event.earned', { generation })
        earnedRef.current = true
        claimTokenRef.current = null
        verificationTokenRef.current = token
        const settlement = pollForVerifiedReward(token)
        rewardSettlementRef.current = settlement
        void settlement
      })
      rewarded.addAdEventListener(AdEventType.OPENED, () => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
        trace('ad_event.opened', { generation })
      })
      rewarded.addAdEventListener(AdEventType.CLOSED, () => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
        trace('ad_event.closed', { earned: earnedRef.current, generation })
        clearLoadTimeout()
        clearCloseTimeout()
        // Keep reward listener alive for one native event-loop turn because
        // CLOSED and EARNED_REWARD can arrive nearly together.
        closeTimeoutRef.current = setTimeout(() => {
          closeTimeoutRef.current = null
          if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
          const earned = earnedRef.current
          rewarded.removeAllListeners()
          rewardedRef.current = null
          if (!earned) {
            claimTokenRef.current = null
            void cancelRewardClaim(token, 'closed_without_reward')
            setErrorState('ad_closed_without_reward')
            return
          }
          // A full-screen ad instance is single-use. Development test ads have no
          // server reward/cooldown, so prepare a fresh instance after settlement.
          if (useTestAd) {
            const settlement = rewardSettlementRef.current ?? Promise.resolve()
            void settlement.then(() => {
              if (mountedRef.current && adGenerationRef.current === generation && stateRef.current === 'ready') {
                void prepareAdRef.current(false)
              }
            })
          }
        }, closeEventGraceMs)
      })
      rewarded.addAdEventListener(AdEventType.ERROR, error => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded) return
        clearLoadTimeout()
        const errorDetails = rewardedAdErrorContext(error)
        const noFill = isNoFillError(error)
        trace('ad_event.error', { ...errorDetails, noFill, generation })
        claimTokenRef.current = null
        void cancelRewardClaim(token, noFill ? 'ad_no_fill' : 'ad_event_error')
        if (noFill) {
          transitionTo('error')
          addAppBreadcrumb('adflow:no_fill', { ...errorDetails, retryable: true, generation })
        } else {
          captureAppError(error, 'ads', 'rewarded_ad')
          setErrorState('ad_event_error', errorDetails)
        }
        rewarded.removeAllListeners()
        rewardedRef.current = null
      })
      rewarded.load()
      loadTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current || adGenerationRef.current !== generation || rewardedRef.current !== rewarded || claimTokenRef.current !== token) return
        claimTokenRef.current = null
        void cancelRewardClaim(token, 'load_timeout')
        rewarded.removeAllListeners()
        rewardedRef.current = null
        setErrorState('ad_load_timeout')
      }, adLoadTimeoutMs)
      trace('prepare_ad.load_invoked', { testAd: useTestAd, generation })
    } catch (error) {
      if (adGenerationRef.current !== generation) return
      clearLoadTimeout()
      if (preparedToken && claimTokenRef.current === preparedToken) {
        claimTokenRef.current = null
        void cancelRewardClaim(preparedToken, 'prepare_exception')
      }
      captureAppError(error, 'ads', 'prepare_rewarded_ad')
      setErrorState('prepare_ad_exception', { message: summarizeError(error) })
    }
  }, [cancelRewardClaim, clearCloseTimeout, clearLoadTimeout, onBalanceChanged, pollForVerifiedReward, readRewardStatus, requestRewardClaim, setErrorState, trace, transitionTo, useTestAd])

  prepareAdRef.current = prepareAd

  useEffect(() => {
    mountedRef.current = true
    void prepareAd()
    return () => {
      mountedRef.current = false
      adGenerationRef.current += 1
      clearLoadTimeout()
      clearCloseTimeout()
      const pendingClaim = claimTokenRef.current
      claimTokenRef.current = null
      if (pendingClaim && !earnedRef.current) void cancelRewardClaim(pendingClaim, 'component_unmount')
      rewardedRef.current?.removeAllListeners()
      rewardedRef.current = null
    }
  }, [cancelRewardClaim, clearCloseTimeout, clearLoadTimeout, prepareAd])

  const press = async () => {
    const currentState = stateRef.current
    if (currentState === 'verification_error') {
      const verificationToken = verificationTokenRef.current
      if (!verificationToken) return
      trace('press.verification_retry')
      transitionTo('verifying')
      rewardSettlementRef.current = pollForVerifiedReward(verificationToken)
      await rewardSettlementRef.current
      return
    }
    if (currentState === 'error') {
      trace('press.retry')
      await prepareAd(true)
      return
    }
    const rewarded = rewardedRef.current
    if (currentState !== 'ready' || !rewarded?.loaded) return
    transitionTo('showing')
    try {
      // Another account on this device may have claimed since this ad loaded.
      const status = await readRewardStatus()
      trace('press.show', { available: status.available, balance: status.balance })
      if (!mountedRef.current) return
      if (!status.available) {
        onBalanceChanged(status.balance)
        transitionTo('cooldown')
        return
      }
      if (rewardedRef.current !== rewarded || !rewarded.loaded) {
        setErrorState('ad_became_unloaded_before_show')
        return
      }
      trace('show.requested')
      await rewarded.show()
    } catch (error) {
      clearLoadTimeout()
      const pendingClaim = claimTokenRef.current
      claimTokenRef.current = null
      if (pendingClaim) void cancelRewardClaim(pendingClaim, 'show_exception')
      captureAppError(error, 'ads', 'show_rewarded_ad')
      setErrorState('show_exception', { message: summarizeError(error) })
    }
  }

  const labels: Record<ButtonState, string> = language === 'ko'
    ? { checking: '광고 상태 확인 중…', loading: '광고 불러오는 중…', ready: '광고 시청 · +50P', showing: '광고 시청 중…', verifying: '보상 확인 중…', verification_error: '보상 다시 확인', cooldown: '광고 완료 · 24시간 후', error: '광고 다시 불러오기' }
    : { checking: 'Checking ad…', loading: 'Loading ad…', ready: 'Watch ad · +50P', showing: 'Ad playing…', verifying: 'Verifying reward…', verification_error: 'Check reward again', cooldown: 'Ad complete · 24h', error: 'Reload ad' }
  const disabled = !['ready', 'error', 'verification_error'].includes(state)

  if (!adsSupported) return null

  return <View style={styles.container}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={language === 'ko' ? '광고 시청으로 50포인트 받기' : 'Watch an ad for 50 points'}
      disabled={disabled}
      onPress={() => void press()}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.icon}>▶</Text>
      <Text numberOfLines={2} style={styles.text}>{labels[state]}</Text>
    </Pressable>
  </View>
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  button: { flex: 1, minWidth: 0, minHeight: 46, borderRadius: 12, paddingHorizontal: 8, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D7CCF5', backgroundColor: '#F4F0FF' },
  disabled: { opacity: 0.58 },
  icon: { color: '#7257B7', fontSize: 12, lineHeight: 15, fontWeight: '900' },
  text: { color: '#5B3E9B', fontSize: 10, lineHeight: 14, fontWeight: '900', textAlign: 'center' },
})

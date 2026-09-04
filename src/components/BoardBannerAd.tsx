import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { initializeMobileAds, mobileAdsSupported } from '../lib/mobileAds'

const productionAdUnitId = 'ca-app-pub-2857738057928315/3416452044'
const useTestAd = __DEV__ || process.env.EXPO_PUBLIC_APP_ENV !== 'production'
const retryDelays = [60_000, 120_000, 240_000]
const requestOptions = { requestNonPersonalizedAdsOnly: true }
type Phase = 'initializing' | 'loading' | 'loaded' | 'waiting' | 'stopped'

export function BoardBannerAd({ language }: { language: 'ko' | 'en' }) {
  if (!mobileAdsSupported()) return null
  return <NativeBoardBannerAd language={language} />
}

function NativeBoardBannerAd({ language }: { language: 'ko' | 'en' }) {
  const [phase, setPhase] = useState<Phase>('initializing')
  const [attempt, setAttempt] = useState(0)
  const [retryAt, setRetryAt] = useState(0)
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
  const failureHandled = useRef(false)

  const fail = useCallback((error: unknown, operation: string) => {
    if (failureHandled.current) return
    failureHandled.current = true
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    // Invalid requests need a configuration fix, not repeated traffic.
    const delay = errorCode.includes('invalid-request') ? undefined : retryDelays[attempt]
    captureAppError(error, 'ads', operation, {
      errorCode, attempt: attempt + 1, testAd: useTestAd,
      adFormat: 'BANNER', retryDelaySeconds: delay == null ? null : delay / 1000,
    })
    setRetryAt(delay == null ? 0 : Date.now() + delay)
    setPhase(delay == null ? 'stopped' : 'waiting')
  }, [attempt])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (phase !== 'initializing' || !active) return
    let cancelled = false
    failureHandled.current = false
    void initializeMobileAds().then(() => {
      if (!cancelled) setPhase('loading')
    }).catch(error => {
      if (!cancelled) fail(error, 'initialize_board_banner')
    })
    return () => { cancelled = true }
  }, [active, phase, fail])

  useEffect(() => {
    if (phase !== 'waiting' || !active) return
    const timer = setTimeout(() => {
      setAttempt(value => value + 1)
      setPhase('initializing')
    }, Math.max(0, retryAt - Date.now()))
    return () => clearTimeout(timer)
  }, [active, phase, retryAt])

  // Unmount only failed requests while waiting. This stops the SDK's automatic
  // refresh from competing with our bounded retry. Successful ads retain the
  // AdMob-configured refresh behavior. Never load ads in a hidden zero-size view.
  if (phase !== 'loading' && phase !== 'loaded') return null
  const { BannerAd, BannerAdSize, TestIds } = require('react-native-google-mobile-ads') as typeof import('react-native-google-mobile-ads')
  const unitId = useTestAd ? TestIds.BANNER : productionAdUnitId

  return <View
    accessibilityLabel={language === 'ko' ? '광고' : 'Advertisement'}
    style={styles.container}
  >
    {phase === 'loaded' && <Text style={styles.label}>{language === 'ko' ? '광고' : 'Ad'}</Text>}
    <BannerAd
      unitId={unitId}
      size={BannerAdSize.BANNER}
      requestOptions={requestOptions}
      onAdLoaded={() => {
        if (failureHandled.current) return
        setPhase('loaded')
        addAppBreadcrumb('board_banner_loaded', { attempt: attempt + 1, testAd: useTestAd })
      }}
      onAdFailedToLoad={error => fail(error, 'board_banner')}
    />
  </View>
}

const styles = StyleSheet.create({
  container: {
    minHeight: 54,
    marginBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  label: {
    alignSelf: 'flex-start',
    marginBottom: 2,
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '800',
  },
})

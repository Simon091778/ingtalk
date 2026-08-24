import { useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads'
import { captureAppError } from '../lib/observability'

const productionAdUnitId = 'ca-app-pub-2857738057928315/3416452044'
const useTestAd = __DEV__ || process.env.EXPO_PUBLIC_APP_ENV !== 'production'

export function BoardBannerAd({ language }: { language: 'ko' | 'en' }) {
  const [failed, setFailed] = useState(false)

  if (Platform.OS !== 'android') return null

  const unitId = useTestAd ? TestIds.ADAPTIVE_BANNER : productionAdUnitId
  if (failed) return null

  return <View
    accessibilityLabel={language === 'ko' ? '광고' : 'Advertisement'}
    style={styles.container}
  >
    <Text style={styles.label}>{language === 'ko' ? '광고' : 'Ad'}</Text>
    <BannerAd
      unitId={unitId}
      size={BannerAdSize.INLINE_ADAPTIVE_BANNER}
      requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      onAdFailedToLoad={error => {
        captureAppError(error, 'ads', 'board_banner')
        setFailed(true)
      }}
    />
  </View>
}

const styles = StyleSheet.create({
  container: {
    minHeight: 56,
    marginBottom: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  label: {
    alignSelf: 'flex-start',
    marginBottom: 4,
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '800',
  },
})

import { Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'

let initialization: Promise<void> | null = null

export function mobileAdsSupported() {
  return Platform.OS === 'android' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient
}

// Share initialization between banners and rewarded ads, without importing the
// native module in Expo Go/iOS/web. A failed initialization can be tried again.
export function initializeMobileAds(): Promise<void> {
  if (!mobileAdsSupported()) return Promise.resolve()
  if (!initialization) {
    initialization = Promise.resolve().then(async () => {
      const { default: mobileAds } = require('react-native-google-mobile-ads') as typeof import('react-native-google-mobile-ads')
      await mobileAds().initialize()
    }).catch(error => {
      initialization = null
      throw error
    })
  }
  return initialization
}

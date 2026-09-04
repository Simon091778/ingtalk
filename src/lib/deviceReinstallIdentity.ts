import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as Crypto from 'expo-crypto'
import type { DeviceReinstallIdentity } from './phoneAuth'
import { isExpoGoAuthTesting } from './expoGoAuth'

// This is an app-scoped reinstall identifier, NOT hardware attestation.
// Raw Android ID never leaves this function or enters logs. A server match
// additionally requires a recently verified SMS before replacing a device key.
export async function getDeviceReinstallIdentity(deviceSecret: string): Promise<DeviceReinstallIdentity> {
  try {
    if (Platform.OS === 'web') return { platform: 'web', identifier: null }
    // Use the existing random-key/browser account path for Expo Go development.
    // It cannot claim a native reinstall identity; SMS and server authorization
    // remain mandatory, and deviceAccountKey uses a separate test credential.
    if (isExpoGoAuthTesting()) return { platform: 'web', identifier: null }
    const appId = Application.applicationId
    if (!appId || appId !== 'kr.ingtalk.app') throw new Error('unsupported_app')
    if (Platform.OS === 'android') {
      const androidId = Application.getAndroidId()?.toLowerCase()
      if (!androidId || !/^[a-f0-9]{1,16}$/.test(androidId) || /^0+$/.test(androidId)
        || androidId === '9774d56d682e549c') throw new Error('invalid_android_id')
      return { platform: 'android', identifier: await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256, `ingtalk-reinstall-v1:android:${appId}:${androidId}`,
      ) }
    }
    if (Platform.OS === 'ios' && /^[a-f0-9]{64}$/.test(deviceSecret)) {
      // IDFV resets when all vendor apps are uninstalled. Use the existing
      // THIS_DEVICE_ONLY Keychain credential, which normally survives reinstall.
      return { platform: 'ios', identifier: await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256, `ingtalk-reinstall-v1:ios:${appId}:${deviceSecret}`,
      ) }
    }
    throw new Error('unsupported_platform')
  } catch {
    // Never fall back to a random or shared identifier and silently lose points.
    throw new Error('device_identity_unavailable')
  }
}

import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'

const INSTALLATION_KEY = 'ingtalk.device-reward-id.v1'

export class DeviceIdentityUnavailableError extends Error {
  constructor() {
    super('device_identity_unavailable')
    this.name = 'DeviceIdentityUnavailableError'
  }
}

async function secureNativeInstallationId() {
  try {
    const saved = await SecureStore.getItemAsync(INSTALLATION_KEY)
    if (saved) return saved
    const created = Crypto.randomUUID()
    await SecureStore.setItemAsync(INSTALLATION_KEY, created)
    const persisted = await SecureStore.getItemAsync(INSTALLATION_KEY)
    if (persisted !== created) throw new DeviceIdentityUnavailableError()
    return created
  } catch (error) {
    if (error instanceof DeviceIdentityUnavailableError) throw error
    // Never fall back to AsyncStorage/localStorage on a native app. Those values
    // disappear on uninstall and could make the same phone look like a new device.
    throw new DeviceIdentityUnavailableError()
  }
}

function webInstallationId() {
  const saved = localStorage.getItem(INSTALLATION_KEY)
  if (saved) return saved
  const created = Crypto.randomUUID()
  localStorage.setItem(INSTALLATION_KEY, created)
  return created
}

export async function getDeviceRewardFingerprint() {
  let source: string
  if (Platform.OS === 'android') {
    const androidId = Application.getAndroidId()
    if (!androidId) throw new DeviceIdentityUnavailableError()
    source = `android:${androidId}`
  } else if (Platform.OS === 'ios') {
    // Keychain-backed SecureStore normally survives reinstall without exposing a hardware identifier.
    source = `ios:${await secureNativeInstallationId()}`
  } else {
    source = `web:${webInstallationId()}`
  }
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `ingtalk-reward-v1:${source}`)
}

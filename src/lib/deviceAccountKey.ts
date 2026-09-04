import { Platform } from 'react-native'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { isExpoGoAuthTesting } from './expoGoAuth'

const storageKey = 'ingtalk.device-account-key.v1'
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
let pending: Promise<string> | undefined

// Random installation credential, never a hardware identifier or user password.
// Do not replace a corrupt/unreadable key: that could silently lose an account.
export function getDeviceAccountKey(): Promise<string> {
  if (pending) return pending
  // Never reuse the production installation credential for an Expo Go account.
  const key = isExpoGoAuthTesting() ? 'ingtalk.expo-go.device-account-key.v1' : storageKey
  pending = (async () => {
    try {
      const read = () => Platform.OS === 'web'
        ? Promise.resolve(localStorage.getItem(key))
        : SecureStore.getItemAsync(key, options)
      const saved = await read()
      if (saved !== null) {
        if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error('invalid_key')
        return saved
      }
      const bytes = await Crypto.getRandomBytesAsync(32)
      const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      if (Platform.OS === 'web') localStorage.setItem(key, value)
      else await SecureStore.setItemAsync(key, value, options)
      if (await read() !== value) throw new Error('key_not_persisted')
      return value
    } catch {
      throw new Error('device_storage_unavailable')
    }
  })().finally(() => { pending = undefined })
  return pending
}

import { NativeModules, Platform } from 'react-native'
import { normalizePhone } from './phoneAuth'

type PhoneNumberHintModule = { requestPhoneNumber: () => Promise<unknown> }

function nativeModule(): PhoneNumberHintModule | null {
  // Expo Go and older binaries lack this optional module. Never block manual SMS.
  if (Platform.OS !== 'android') return null
  try {
    const module = NativeModules.IngtalkPhoneNumberHint as PhoneNumberHintModule | undefined
    return typeof module?.requestPhoneNumber === 'function' ? module : null
  } catch { return null }
}

export function supportsPhoneNumberHint(): boolean {
  return nativeModule() !== null
}

export async function requestPhoneNumberHint(): Promise<string | null> {
  try {
    const result = await nativeModule()?.requestPhoneNumber()
    return typeof result === 'string' ? normalizePhone(result) : null
  } catch {
    // Cancellation, no SIM/Play services and malformed hints all allow typing.
    // Never log a phone number, native exception or authentication credential.
    return null
  }
}

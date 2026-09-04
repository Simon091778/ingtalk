import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

type SmsConsentModule = {
  startListening: (id: string) => Promise<boolean>
  stopListening: (id: string) => void
  addListener: (name: string) => void
  removeListeners: (count: number) => void
}

let sequence = 0
const noop = () => {}

// Optional native enhancement. Missing modules (including Expo Go), cancellation
// and setup failures never block sending SMS or using the keyboard.
export async function prepareSmsCodeAutofill(onCode: (code: string) => void): Promise<() => void> {
  if (Platform.OS !== 'android') return noop
  let module: SmsConsentModule | undefined
  try { module = NativeModules.IngtalkSmsConsent as SmsConsentModule | undefined } catch { return noop }
  if (!module || typeof module.startListening !== 'function' || typeof module.stopListening !== 'function'
    || typeof module.addListener !== 'function' || typeof module.removeListeners !== 'function') return noop
  const native = module
  const id = `${Date.now()}-${++sequence}`
  let active = true
  let subscription: { remove: () => void } | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let setupTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (!active) return
    active = false
    if (expiry) clearTimeout(expiry)
    try { subscription?.remove() } catch { /* best effort */ }
    try { native.stopListening(id) } catch { /* best effort */ }
  }
  try {
    subscription = new NativeEventEmitter(native).addListener('IngtalkSmsConsentResult', result => {
      if (!active || result?.requestId !== id) return
      stop()
      if (typeof result.code === 'string' && /^\d{6}$/.test(result.code)) onCode(result.code)
    })
    expiry = setTimeout(stop, 5 * 60_000)
    const ready = await Promise.race([
      native.startListening(id),
      new Promise<boolean>(resolve => { setupTimer = setTimeout(() => resolve(false), 1500) }),
    ])
    if (!ready) stop()
  } catch { stop() }
  finally { if (setupTimer) clearTimeout(setupTimer) }
  return stop
}

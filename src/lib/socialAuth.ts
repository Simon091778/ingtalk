import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Linking, Platform } from 'react-native'
import type { WebBrowserAuthSessionResult } from 'expo-web-browser'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { authorizeDeviceAccount } from './phoneAuth'
import { getDeviceAccountKey } from './deviceAccountKey'
import { getDeviceReinstallIdentity } from './deviceReinstallIdentity'
import { accountProvider, type SocialProvider } from './authProviders'
import { addAppBreadcrumb, captureAppError } from './observability'

export const SOCIAL_REDIRECTS = { google: 'ingtalk://auth/google', kakao: 'ingtalk://auth/kakao' } as const
export function socialCallbackCode(callback: string, provider: SocialProvider): string {
  const url = new URL(callback)
  const expected = new URL(SOCIAL_REDIRECTS[provider])
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname
    || url.username || url.password || url.hash || url.searchParams.has('error')
    || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) throw new Error(`${provider}_auth_failed`)
  return url.searchParams.get('code')!
}

async function openSocialAuthSession(start: string, redirect: string, signal?: AbortSignal): Promise<WebBrowserAuthSessionResult> {
  // Keep the native module lazy so older binaries can still use phone auth.
  const browser = require('expo-web-browser') as typeof import('expo-web-browser')
  if (signal?.aborted) return { type: browser.WebBrowserResultType.CANCEL }
  if (Platform.OS !== 'android') {
    const abort = () => { try { browser.dismissAuthSession() } catch { /* Session already closed. */ } }
    signal?.addEventListener('abort', abort)
    try { return await browser.openAuthSessionAsync(start, redirect) }
    finally { signal?.removeEventListener('abort', abort) }
  }

  // SDK 54's default NEW_TASK + NO_HISTORY discards Custom Tabs when Kakao or
  // another external authenticator opens. Keep the browser in the app's task.
  // Do not use SDK 54's AppState-based auth polyfill: Google account addition/MFA
  // can resume the app before authentication finishes. Only a matching callback,
  // explicit cancellation or the bounded timeout may finish this attempt.
  const expected = new URL(redirect)
  let resolveCallback!: (result: WebBrowserAuthSessionResult) => void
  const callback = new Promise<WebBrowserAuthSessionResult>(resolve => { resolveCallback = resolve })
  const subscription = Linking.addEventListener('url', event => {
    try {
      const url = new URL(event.url)
      if (url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
        && !url.username && !url.password) resolveCallback({ type: 'success', url: event.url })
    } catch { /* Unrelated or malformed links cannot finish this auth attempt. */ }
  })
  const abort = () => resolveCallback({ type: browser.WebBrowserResultType.CANCEL })
  signal?.addEventListener('abort', abort)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    resolveCallback({ type: browser.WebBrowserResultType.DISMISS })
  }, 5 * 60_000)
  try {
    const result = await browser.openBrowserAsync(start, { createTask: false })
    if (signal?.aborted) return { type: browser.WebBrowserResultType.CANCEL }
    if (result.type !== 'opened') return result
    const returned = await callback
    if (timedOut) throw new Error('social_auth_timeout')
    return returned
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    subscription.remove()
  }
}

let pending = false
export async function signInWithSocialProvider(provider: SocialProvider, target: SupabaseClient, isActive: () => boolean = () => true,
  consumeForLink?: (verifiedClient: SupabaseClient) => Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (pending) return false
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    throw new Error(`${provider}_native_required`)
  }
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error(`${provider}_not_configured`)
  const redirect = SOCIAL_REDIRECTS[provider]
  pending = true
  let client: SupabaseClient | undefined
  let promoted = false
  let stage = 'configuration'
  const active = () => isActive() && !signal?.aborted
  try {
    if (!active()) return false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key }, signal: controller.signal })
      if (!settings.ok || (await settings.json()).external?.[provider] !== true) throw new Error(`${provider}_not_configured`)
    } finally { clearTimeout(timeout) }
    stage = 'device_identity'
    const secret = await getDeviceAccountKey()
    const identity = await getDeviceReinstallIdentity(secret)
    if (!active()) return false
    // Separate PKCE/session storage prevents cancellation or provider errors from
    // replacing a pending SMS session. No OAuth tokens enter deep-link URLs.
    const memory = new Map<string, string>()
    client = createClient(url, key, { auth: {
      flowType: 'pkce', autoRefreshToken: false, persistSession: true, detectSessionInUrl: false,
      storageKey: `ingtalk.${provider}.pending`,
      storage: { getItem: name => memory.get(name) ?? null, setItem: (name, value) => { memory.set(name, value) }, removeItem: name => { memory.delete(name) } },
    } })
    stage = 'authorize_start'
    const { data, error } = await client.auth.signInWithOAuth({ provider, options: {
      redirectTo: redirect, skipBrowserRedirect: true,
      ...(provider === 'google'
        ? { scopes: 'openid email profile', queryParams: { prompt: 'select_account' } }
        // Supabase's adapter adds profile/email scopes by default. Singular scope
        // overrides them; plural scopes appends. Kakao optional data stays disabled.
        : { queryParams: { scope: '', prompt: 'login' } }),
    } })
    if (error || !data.url) throw new Error(`${provider}_auth_failed`)
    if (!active()) return false
    stage = 'browser_return'
    const result = await openSocialAuthSession(data.url, redirect, signal)
    if (!active()) return false
    addAppBreadcrumb('social_auth_browser_return', { provider, result: result.type, platform: Platform.OS })
    if (result.type === 'cancel') return false
    if (result.type !== 'success') throw new Error(`${provider}_auth_interrupted`)
    stage = 'code_exchange'
    const exchanged = await client.auth.exchangeCodeForSession(socialCallbackCode(result.url, provider))
    if (exchanged.error || !exchanged.data.session) throw new Error(`${provider}_auth_failed`)
    const session = exchanged.data.session
    if (!active()) return false
    if (accountProvider(session.user) !== provider || session.user.phone
      || session.user.identities?.some(item => item.provider !== provider)) throw new Error(`${provider}_identity_conflict`)
    if (provider === 'kakao' && session.user.email) throw new Error('kakao_privacy_configuration')
    if (consumeForLink) {
      if (!active()) return false
      // Linking must never enroll a second app account or replace the source session.
      stage = 'account_link'
      await consumeForLink(client)
      return true
    }
    stage = 'device_authorization'
    await authorizeDeviceAccount(client, secret, identity, provider)
    if (!active()) return false
    // Only a server-authorized principal is allowed into the persistent app client.
    stage = 'session_promotion'
    const saved = await target.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    if (saved.error) throw new Error(`${provider}_auth_failed`)
    promoted = true
    return true
  } catch (reason) {
    const safeErrors = [`${provider}_not_configured`, `${provider}_auth_interrupted`, `${provider}_identity_conflict`, 'social_auth_timeout', 'account_service_unavailable',
      'device_storage_unavailable', 'device_identity_unavailable', 'device_binding_mismatch',
      'device_creation_rate_limited', 'recovery_rate_limited', 'account_deletion_pending',
      'reauthenticate_required', `fresh_${provider}_verification_required`, 'account_link_required', 'kakao_privacy_configuration',
      'device_enrollment_cooldown', 'account_switch_rate_limited', 'account_link_conflict', 'account_link_unavailable', 'account_resolution_required',
      'manual_merge_required', 'invalid_link_ticket', 'link_verification_required', 'invalid_account_response']
    const safeError = new Error(reason instanceof Error && safeErrors.includes(reason.message) ? reason.message : `${provider}_auth_failed`)
    // Never send provider error text, callback URLs, authorization codes or tokens.
    if (['account_link_required', 'account_switch_rate_limited', 'device_creation_rate_limited'].includes(safeError.message)) {
      // This is an expected account-protection decision, not a crash. In dev,
      // console.error would cover the actionable linking guide with LogBox.
      addAppBreadcrumb(`social_auth_${safeError.message}`, { provider, stage, platform: Platform.OS })
    } else {
      captureAppError(safeError, 'auth', `${provider}_sign_in`, { stage, platform: Platform.OS })
    }
    throw safeError
  } finally {
    if (client) {
      if (!promoted) await client.auth.signOut({ scope: 'local' }).catch(() => {})
      await client.auth.stopAutoRefresh().catch(() => {})
    }
    pending = false
  }
}

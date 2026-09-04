import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getDeviceAccountKey } from './deviceAccountKey'
import { getDeviceReinstallIdentity } from './deviceReinstallIdentity'
import type { DeviceReinstallIdentity } from './phoneAuth'
import { authorizeDeviceAccount } from './phoneAuth'
import { accountProvider, LOGIN_PROVIDERS, type LoginProvider } from './authProviders'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export type { LoginProvider } from './authProviders'
export type AccountLinkRequest = { ticket: string; accountId: string; provider: LoginProvider; secret: string; identity: DeviceReinstallIdentity }

export async function accountLoginMethods(client: SupabaseClient): Promise<{ accountId: string; providers: LoginProvider[] }> {
  const { data, error } = await client.rpc('account_login_methods')
  if (error) throw new Error('account_service_unavailable')
  if (!uuid.test(data?.account_id ?? '') || !Array.isArray(data?.providers) || !data.providers.length
    || data.providers.length > 3 || new Set(data.providers).size !== data.providers.length
    || data.providers.some((item: unknown) => !LOGIN_PROVIDERS.includes(item as LoginProvider))) throw new Error('invalid_account_response')
  return { accountId: data.account_id, providers: data.providers }
}

export async function beginAccountLink(client: SupabaseClient, expectedAccountId: string, provider?: LoginProvider): Promise<AccountLinkRequest> {
  const secret = await getDeviceAccountKey()
  const identity = await getDeviceReinstallIdentity(secret)
  const { data, error } = await client.rpc(provider ? 'begin_account_link_v2' : 'begin_account_link', {
    device_secret: secret, device_platform: identity.platform, reinstall_identifier: identity.identifier,
    ...(provider ? { target_provider: provider } : {}),
  })
  if (error) throw new Error('account_service_unavailable')
  if (data?.error) throw new Error(String(data.error))
  if (data?.ok !== true || data.account_id !== expectedAccountId || !uuid.test(data.account_id)
    || !/^[a-f0-9]{64}$/.test(data.ticket ?? '') || !LOGIN_PROVIDERS.includes(data.provider)
    || (provider && data.provider !== provider)) throw new Error('invalid_account_response')
  // Ticket and device proof exist only in memory, never in URLs, logs or storage.
  return { ticket: data.ticket, accountId: data.account_id, provider: data.provider, secret, identity }
}

export async function finishAccountLink(verifiedClient: SupabaseClient, request: AccountLinkRequest): Promise<{ accountId: string; recoveredExistingAccount: boolean }> {
  const { data, error } = await verifiedClient.rpc('finish_account_link', {
    link_ticket: request.ticket, device_secret: request.secret,
    device_platform: request.identity.platform, reinstall_identifier: request.identity.identifier,
  })
  if (error) throw new Error('account_service_unavailable')
  if (data?.error) {
    const reason = typeof data.reason === 'string' ? data.reason : ''
    if (data.error === 'manual_merge_required') {
      if (['point_spent', 'profile_activity', 'custom_settings', 'user_activity', 'storage_exists'].includes(reason)) {
        throw new Error('manual_merge_activity')
      }
      if (reason) throw new Error('manual_merge_accounting')
    }
    throw new Error(String(data.error))
  }
  const recoveredExistingAccount = data?.recovered_existing_account === true
  const validRecovery = recoveredExistingAccount && data?.account_id === request.accountId
    && uuid.test(data?.recovered_account_id ?? '') && data.recovered_account_id !== request.accountId
    && data.previous_account_id === request.accountId
  const validOrdinaryLink = !recoveredExistingAccount && data?.account_id === request.accountId
  if (data?.ok !== true || (!validRecovery && !validOrdinaryLink)) throw new Error('invalid_account_response')
  return { accountId: recoveredExistingAccount ? data.recovered_account_id : data.account_id, recoveredExistingAccount }
}

export async function reauthorizeAccountSession(mainClient: SupabaseClient, verifiedClient: SupabaseClient,
  expectedAccountId: string): Promise<LoginProvider> {
  const current = await verifiedClient.auth.getSession()
  const session = current.data.session
  if (current.error || !session?.access_token || !session.refresh_token) throw new Error('link_verification_required')
  const provider = accountProvider(session.user)
  const secret = await getDeviceAccountKey()
  const identity = await getDeviceReinstallIdentity(secret)
  const authorized = await authorizeDeviceAccount(verifiedClient, secret, identity, provider)
  if (authorized.account_id !== expectedAccountId) throw new Error('account_link_conflict')
  const saved = await mainClient.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
  if (saved.error) throw new Error('account_service_unavailable')
  return provider
}

export function createLinkPhoneClient(): SupabaseClient {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('account_service_unavailable')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'ingtalk.link.phone' } })
}

export async function discardLinkClient(client: SupabaseClient): Promise<void> {
  // The temporary verification session is never promoted into the app client.
  await client.auth.signOut({ scope: 'local' }).catch(() => {})
  await client.auth.stopAutoRefresh().catch(() => {})
}

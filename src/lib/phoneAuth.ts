import type { SupabaseClient } from '@supabase/supabase-js'
import type { LoginProvider } from './authProviders'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

// Auth UID proves provider identity; only this server-selected ID owns app data.
export async function getAccountId(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client.rpc('current_account_id')
  if (error) throw new Error('account_service_unavailable')
  if (data === null) return null
  if (typeof data !== 'string' || !uuid.test(data)) throw new Error('invalid_account_response')
  return data
}

export type DeviceReinstallIdentity = { platform: 'android' | 'ios' | 'web'; identifier: string | null }

export async function authorizeDeviceAccount(client: SupabaseClient, deviceSecret: string, identity?: DeviceReinstallIdentity, provider: LoginProvider = 'phone') {
  if (provider !== 'phone' && !identity) throw new Error('device_identity_unavailable')
  const { data, error } = identity
    ? await client.rpc(provider === 'phone' ? 'authorize_device_account_v2' : `authorize_${provider}_device_account`, { device_secret: deviceSecret, device_platform: identity.platform, reinstall_identifier: identity.identifier })
    : await client.rpc('authorize_device_account', { device_secret: deviceSecret })
  if (error) throw new Error('account_service_unavailable')
  if (data?.error) throw new Error(String(data.error))
  if (data?.ok !== true || typeof data.account_id !== 'string' || !uuid.test(data.account_id)
    || typeof data.created !== 'boolean' || (identity && typeof data.restored !== 'boolean')) throw new Error('invalid_account_response')
  return data as { ok: true; account_id: string; created: boolean; restored?: boolean }
}

export async function signOutAccount(client: SupabaseClient) {
  const { data: { session } } = await client.auth.getSession()
  if (session && !session.user.is_anonymous) {
    const { error } = await client.rpc('lock_account_session')
    if (error) throw new Error('account_service_unavailable')
  }
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw error
  // Keep the installation key so this phone + device can sign in again.
}

export function normalizePhone(input: string): string {
  const value = input.trim().replace(/[\s().-]/g, '')
  const phone = /^010\d{8}$/.test(value) ? `+82${value.slice(1)}`
    // Supabase Auth/JWT data can expose the same Korean E.164 number without
    // its leading plus. Accept only the unambiguous Korean mobile form here.
    : /^8210\d{8}$/.test(value) ? `+${value}`
    : value
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('invalid_phone')
  return phone
}

export function phoneInputValue(input: string): string {
  const normalized = normalizePhone(input)
  return /^\+8210\d{8}$/.test(normalized) ? `0${normalized.slice(3)}` : normalized
}

export function authErrorText(error: unknown, english = false): string {
  const code = error instanceof Error ? error.message : ''
  const messages: Record<string, [string, string]> = {
    social_auth_timeout: ['인증 대기 시간이 지났어요. 다시 시도해 주세요.', 'Verification timed out. Please try again.'],
    kakao_not_configured: ['카카오 로그인을 준비 중입니다. 전화번호 또는 Google 인증을 이용해 주세요.', 'Kakao sign-in is not configured yet. Please use phone or Google verification.'],
    kakao_native_required: ['카카오 로그인은 개발용 또는 정식 앱에서 사용할 수 있어요. Expo Go에서는 전화번호 인증을 이용해 주세요.', 'Use a development or standalone app for Kakao sign-in. In Expo Go, use phone verification.'],
    kakao_auth_failed: ['카카오 로그인에 실패했어요. 연결 상태를 확인하고 다시 시도해 주세요.', 'Kakao sign-in failed. Check your connection and try again.'],
    kakao_auth_interrupted: ['카카오 인증이 완료되기 전에 로그인 창이 닫혔어요. 다시 시도해 주세요.', 'The sign-in window closed before Kakao verification finished. Please try again.'],
    kakao_identity_conflict: ['다른 로그인 방식이 섞인 카카오 인증은 사용할 수 없어요. 기존 로그인 방식으로 다시 로그인해 주세요.', 'This Kakao identity conflicts with another sign-in method. Use your original sign-in method.'],
    kakao_privacy_configuration: ['개인정보 최소 수집 설정을 확인해야 합니다. 지금은 다른 인증 방법을 이용해 주세요.', 'The minimal-data settings need to be checked. Please use another sign-in method for now.'],
    fresh_kakao_verification_required: ['카카오 계정을 다시 인증해 주세요.', 'Please verify your Kakao account again.'],
    account_link_required: ['이 휴대폰에는 다른 로그인 수단으로 등록한 잉톡 계정이 있어요. 전화번호 인증이 필수라는 뜻은 아닙니다. 이전에 사용한 Google 또는 카카오 계정, 전화번호로 로그인한 뒤 내 정보 → 로그인 및 계정 관리 → 로그인 수단 연결에서 추가해 주세요. 기존 계정과 포인트는 유지됩니다.', 'This phone already belongs to an Ingtalk account registered with another sign-in method. Phone verification is not required. Sign in with the Google account, Kakao account or phone number you previously used, then go to My Info → Login & account management → Linked sign-in methods. Your existing account and points are preserved.'],
    account_resolution_required: ['이 로그인 수단에 기존 잉톡 계정이 여러 개 있어 임의로 선택할 수 없어요. 기존 계정에 연결한 Google·카카오 또는 이전 기기로 로그인하거나 고객지원에 문의해 주세요. 포인트는 합치거나 삭제하지 않습니다.', 'This method matches more than one Ingtalk account, so no account was selected. Use a Google or Kakao method linked to the account, a previous device, or contact support. Points are not merged or deleted.'],
    phone_identity_conflict: ['이 휴대폰 번호는 다른 활성 계정에 연결되어 있거나 기존 소유자가 여러 명이어서 자동으로 연결할 수 없어요. 계정을 합치거나 삭제하지 않았으며, 고객지원에 문의해 주세요.', 'This phone number belongs to another active account or has multiple legacy owners, so it cannot be linked automatically. No account was merged or deleted. Contact support.'],
    device_enrollment_cooldown: ['탈퇴 후 같은 기기에서 다시 가입하려면 7일이 지나야 합니다. 다른 사람이 사용하던 기기라면 고객지원에 문의해 주세요.', 'Wait 7 days after account deletion to register on this device again. Contact support if this is a secondhand device.'],
    link_reauthentication_required: ['현재 계정을 유지한 채 앱 안에서 같은 로그인 방식을 다시 인증한 후 10분 안에 연결해 주세요.', 'Keep the current account signed in, verify the same sign-in method in the app, then link within 10 minutes.'],
    account_link_conflict: ['이 로그인 수단은 이미 다른 계정에 등록되어 있어 연결할 수 없어요. 두 계정의 포인트와 대화는 합치거나 삭제하지 않습니다.', 'This sign-in method already belongs to another account. Its points and chats will not be merged or deleted.'],
    manual_merge_required: ['휴대폰 계정에 구매·관리자 조정·원장 불일치 등 보호해야 할 기록이 있어 자동으로 연결할 수 없어요. 기존 로그인 방식으로 이용하거나 고객지원에 문의해 주세요.', 'This phone account contains a purchase, admin adjustment, ledger mismatch, or another protected record that cannot be retired automatically. Keep using its original sign-in method or contact support.'],
    manual_merge_activity: ['현재 휴대폰 계정에 별도로 보존해야 할 이용 기록이 있어 자동으로 계정을 연결할 수 없어요. 기존 로그인 방식으로 이용하거나 고객지원에 문의해 주세요.', 'This phone account has separate activity that must be preserved, so it cannot be linked automatically. Keep using its original sign-in method or contact support.'],
    manual_merge_accounting: ['현재 휴대폰 계정의 포인트 상태를 자동으로 확인할 수 없어 계정을 연결하지 않았어요. 기존 로그인 방식으로 이용하거나 고객지원에 문의해 주세요.', 'The point state of this phone account could not be verified automatically, so the account was not linked. Keep using its original sign-in method or contact support.'],
    account_link_unavailable: ['현재 계정과 등록된 기기를 확인하지 못해 연결할 수 없어요. 기존 계정으로 다시 로그인해 주세요.', 'Cannot link without verifying the current account and registered device. Sign in to the original account again.'],
    account_already_linked: ['이미 연결된 로그인 수단입니다.', 'This sign-in method is already linked.'],
    invalid_link_provider: ['추가할 로그인 수단을 다시 선택해 주세요.', 'Select the sign-in method you want to add again.'],
    link_rate_limited: ['계정 연결 시도가 너무 많아요. 1시간 후 다시 시도해 주세요.', 'Too many linking attempts. Try again after one hour.'],
    invalid_link_ticket: ['연결 요청이 만료되었거나 이미 사용되었어요. 닫은 뒤 다시 연결해 주세요.', 'This linking request has expired or was already used. Close it and start again.'],
    link_verification_required: ['추가할 로그인 수단을 다시 인증해 주세요.', 'Verify the sign-in method you want to add again.'],
    google_not_configured: ['Google 로그인을 준비 중입니다. 지금은 전화번호 인증을 이용해 주세요.', 'Google sign-in is not configured yet. Please use phone verification.'],
    google_native_required: ['Google 로그인은 개발용 또는 정식 앱에서 사용할 수 있어요. Expo Go에서는 전화번호 인증을 이용해 주세요.', 'Use a development or standalone app for Google sign-in. In Expo Go, use phone verification.'],
    google_auth_failed: ['Google 로그인에 실패했어요. 연결 상태를 확인하고 다시 시도해 주세요.', 'Google sign-in failed. Check your connection and try again.'],
    google_auth_interrupted: ['Google 인증이 완료되기 전에 로그인 창이 닫혔어요. 다시 시도해 주세요.', 'The sign-in window closed before Google verification finished. Please try again.'],
    google_identity_conflict: ['다른 인증 방식이 연결된 계정은 자동으로 합치지 않습니다. 기존 로그인 방식을 이용해 주세요.', 'Accounts linked to another sign-in method are not merged. Use your original sign-in method.'],
    fresh_google_verification_required: ['Google 계정을 다시 선택하여 로그인해 주세요.', 'Please sign in with Google again.'],
    invalid_phone: ['한국 번호는 010으로, 해외 번호는 +국가번호로 입력해 주세요.', 'Enter a Korean 010 number or an international number starting with +.'],
    phone_reauthentication_mismatch: ['현재 계정에 등록된 휴대폰 번호로만 다시 인증할 수 있어요.', 'Reauthentication must use the phone number registered to the current account.'],
    device_creation_rate_limited: ['새 계정 또는 기기 등록이 너무 많아요. 기존 계정으로 로그인하거나 24시간 후 다시 시도해 주세요.', 'Too many new accounts or device registrations. Sign in to an existing account or try again after 24 hours.'],
    account_switch_rate_limited: ['로그인 시도가 너무 많아요. 1시간 후 다시 시도해 주세요. 기존 계정과 포인트는 유지됩니다.', 'Too many sign-in attempts. Try again after one hour. Your existing accounts and points are preserved.'],
    account_deletion_pending: ['계정 삭제를 마무리하고 있어요. 잠시 후 다시 시도해 주세요.', 'Account deletion is in progress. Please try again later.'],
    device_storage_unavailable: ['기기 보안 저장소를 사용할 수 없어요. 앱을 재시작해 주세요. 앱 데이터를 지우면 기존 계정을 복구하지 못할 수 있어요.', 'Secure storage is unavailable. Restart the app. Clearing app data may prevent account restoration.'],
    device_identity_unavailable: ['이 휴대폰의 복구 정보를 확인하지 못했어요. 정식 앱을 다시 실행해 주세요. 새 계정으로 임의 전환하지 않습니다.', 'Cannot verify this device identity. Restart the official app. Your account will not be silently replaced.'],
    device_binding_mismatch: ['등록된 휴대폰 정보와 일치하지 않습니다. 로그인 처음부터 다시 시도해 주세요.', 'The registered device does not match. Start sign-in again.'],
    recovery_rate_limited: ['기기 복구 시도가 너무 많아요. 1시간 후 다시 시도해 주세요.', 'Too many device recovery attempts. Try again after one hour.'],
    otp_verification_failed: ['인증번호가 올바르지 않거나 만료되었습니다. 새 인증번호를 요청한 뒤 다시 시도해 주세요.', 'The verification code is invalid or expired. Request a new code and try again.'],
    otp_session_missing: ['전화번호 인증 세션을 만들지 못했습니다. 새 인증번호를 요청한 뒤 다시 시도해 주세요.', 'Could not create a phone verification session. Request a new code and try again.'],
    account_service_unavailable: ['전화번호 인증은 완료됐지만 계정 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'Phone verification succeeded, but the account could not be prepared. Try again shortly.'],
    invalid_account_response: ['전화번호 인증은 완료됐지만 계정 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'Phone verification succeeded, but the account response was invalid. Try again shortly.'],
  }
  return messages[code]?.[english ? 1 : 0] ?? (english
    ? 'Unable to verify. Check the code and connection, then try again.'
    : '인증하지 못했어요. 인증번호와 연결 상태를 확인한 뒤 다시 시도해 주세요.')
}

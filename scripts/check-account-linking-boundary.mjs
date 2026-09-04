// No sign-in, SMS, account creation, linking or deletion. Only anonymous denials.
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : []
}))
const base = env.EXPO_PUBLIC_SUPABASE_URL
const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!base || !key) throw new Error('Missing public Supabase configuration')
for (const [path, body] of [
  ['/rest/v1/rpc/admin_get_account_operations', { target_user_uuid: '00000000-0000-4000-8000-000000000000' }],
  ['/rest/v1/rpc/admin_revoke_device_sessions', { target_user_uuid: '00000000-0000-4000-8000-000000000000', target_device_uuid: '00000000-0000-4000-8000-000000000000', admin_note: '' }],
  ['/rest/v1/rpc/authorize_google_device_account', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) }],
  ['/rest/v1/rpc/authorize_kakao_device_account', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) }],
  ['/rest/v1/rpc/begin_account_link_v2', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64), target_provider: 'kakao' }],
  ['/rest/v1/rpc/begin_account_link', { device_secret: 'a'.repeat(64), device_platform: 'web', reinstall_identifier: null }],
  ['/rest/v1/rpc/finish_account_link', { link_ticket: 'b'.repeat(64), device_secret: 'a'.repeat(64), device_platform: 'web', reinstall_identifier: null }],
  ['/functions/v1/delete-account', { confirmation: false }],
]) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if (![401, 403].includes(response.status)) throw new Error(`Unexpected anonymous response: ${path} HTTP ${response.status}`)
  console.log(JSON.stringify({ operation: path.split('/').at(-1), anonymousDenied: true, status: response.status }))
}

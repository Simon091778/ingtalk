// Opt-in live smoke test. Uses only the private synthetic review identity.
// Creates/reuses an app account for the saved synthetic device; never posts,
// buys, grants points, changes Auth configuration, or logs tokens/credentials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const platform = process.argv.find(arg => arg.startsWith('--platform='))?.split('=')[1] ?? 'android'
if (!process.argv.includes('--live') || !['android', 'ios'].includes(platform)) {
  throw new Error('Usage: node scripts/check-play-review-access.mjs --live --platform=android|ios')
}
const privatePath = '.private/play-review-access.json'
const credentials = JSON.parse(readFileSync(privatePath, 'utf8'))
// NANPA-reserved fictional range; refuse to send an OTP to a real number.
assert.match(credentials.phone, /^\+120255501\d{2}$/)
assert.match(credentials.code, /^\d{6}$/)
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : []
}))
const url = env.EXPO_PUBLIC_SUPABASE_URL
assert.equal(new URL(url).hostname, `${credentials.projectRef}.supabase.co`)
const client = createClient(url, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const device = credentials.devices[platform]
assert.match(device.secret, /^[a-f0-9]{64}$/)
assert.match(device.identifier, /^[a-f0-9]{64}$/)
const resultPath = '.private/play-review-verification.json'
const previous = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : []
const checks = []
function checked(condition, label) { assert.ok(condition, label); checks.push(label) }
try {
  const unmappedPhone = credentials.phone === '+12025550199' ? '+12025550198' : '+12025550199'
  const unmapped = await client.auth.verifyOtp({ phone: unmappedPhone, token: credentials.code, type: 'sms' })
  checked(!!unmapped.error && !unmapped.data.session, 'Review code rejected for a different number (no SMS requested)')
  const sent = await client.auth.signInWithOtp({ phone: credentials.phone, options: { shouldCreateUser: true, channel: 'sms' } })
  checked(!sent.error, `OTP request accepted${sent.error ? ` (${sent.error.code ?? sent.error.status})` : ''}`)
  const wrongCode = String((Number(credentials.code) + 1) % 1000000).padStart(6, '0')
  const wrong = await client.auth.verifyOtp({ phone: credentials.phone, token: wrongCode, type: 'sms' })
  checked(!!wrong.error && !wrong.data.session, 'Wrong code rejected')
  const verified = await client.auth.verifyOtp({ phone: credentials.phone, token: credentials.code, type: 'sms' })
  checked(!verified.error && !!verified.data.session, `Review code accepted${verified.error ? ` (${verified.error.code ?? verified.error.status})` : ''}`)
  checked(verified.data.user?.phone === credentials.phone.slice(1) && !verified.data.user?.is_anonymous, 'Verified phone identity, not anonymous')
  const jwt = JSON.parse(Buffer.from(verified.data.session.access_token.split('.')[1], 'base64url').toString())
  checked(jwt.amr?.some(item => item.method === 'otp') && jwt.role === 'authenticated', 'Normal authenticated OTP session')
  const unbound = await client.rpc('current_account_id')
  checked(!unbound.error && unbound.data === null, 'App account unavailable before device authorization')
  const params = { device_secret: device.secret, device_platform: platform, reinstall_identifier: device.identifier }
  const authorized = await client.rpc('authorize_device_account_v2', params)
  checked(!authorized.error && authorized.data?.ok === true, `Device account authorized${authorized.data?.error ? ` (${authorized.data.error})` : ''}`)
  const accountId = authorized.data.account_id
  // Historical account IDs can be retired by an intentional canonical merge.
  // Verify idempotency against the live resolver instead of treating an old
  // verification artifact as the permanent canonical owner.
  const repeated = await client.rpc('authorize_device_account_v2', params)
  checked(!repeated.error && repeated.data?.account_id === accountId && !repeated.data?.created,
    'Repeat sign-in retains the same device account')
  const other = previous.findLast(item => item.platform !== platform)
  if (other) checked(accountId !== other.accountId, 'Different devices have isolated phone accounts')
  const current = await client.rpc('current_account_id')
  checked(!current.error && current.data === accountId, 'App account resolves after authorization')
  const profile = await client.from('profiles').select('nickname,birth_year,gender,welcome_points_claimed').eq('id', accountId).single()
  checked(!profile.error && !!profile.data.nickname && !!profile.data.gender && profile.data.birth_year <= new Date().getFullYear() - 19,
    'Synthetic adult profile is ready without reviewer signup')
  checked(profile.data.welcome_points_claimed === true, 'Review profile cannot also claim a welcome grant')
  const wallet = await client.rpc('my_point_balance')
  checked(!wallet.error && typeof wallet.data === 'number', 'Review wallet is accessible')
  const grants = await client.from('point_transactions').select('amount,reason').eq('user_id', accountId).in('reason', ['review_access', 'review_access_adjustment'])
  checked(!grants.error && grants.data?.filter(row => row.reason === 'review_access').length === 1
    && grants.data.reduce((sum, row) => sum + row.amount, 0) === 1000, 'One review grant with a net allocation of 1000 points')
  const mismatch = await client.rpc('authorize_device_account_v2', { ...params, reinstall_identifier: randomBytes(32).toString('hex') })
  const safeBindingErrors = new Set(['device_binding_mismatch', 'reauthenticate_required'])
  checked(!mismatch.error && mismatch.data?.ok !== true && safeBindingErrors.has(mismatch.data?.error),
    `Copied device key cannot bypass native binding${mismatch.error || !safeBindingErrors.has(mismatch.data?.error) ? ` (${mismatch.error?.message ?? mismatch.data?.error ?? 'unexpected success'})` : ''}`)
  const admin = await client.rpc('admin_get_account_operations', { target_user_uuid: accountId })
  checked(admin.error?.code === '42501', 'Review identity has no administrator access')
  const locked = await client.rpc('lock_account_session')
  checked(!locked.error, 'App session lock succeeds')
  const afterLock = await client.rpc('current_account_id')
  checked(!afterLock.error && afterLock.data === null, 'Locked session cannot access app account')
  const signedOut = await client.auth.signOut({ scope: 'local' })
  checked(!signedOut.error, 'Auth sign-out succeeds')
  const result = { checkedAt: new Date().toISOString(), platform, accountId, created: authorized.data.created, balance: wallet.data, checks }
  writeFileSync(resultPath, JSON.stringify([...previous, result], null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...result, accountId: '[private]' }, null, 2))
} finally {
  await client.auth.signOut({ scope: 'local' })
}

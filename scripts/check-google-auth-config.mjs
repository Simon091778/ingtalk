// Non-sign-in probe: starts PKCE authorization then cancels it. No Google account,
// SMS, code exchange, account grant, or wallet is touched. Never print OAuth state.
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : []
}))
const base = env.EXPO_PUBLIC_SUPABASE_URL
const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!base || !key) throw new Error('Supabase public configuration missing')
const appRedirect = 'ingtalk://auth/google'
const expectedCallback = `${base}/auth/v1/callback`
const authUrl = new URL(`${base}/auth/v1/authorize`)
const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
authUrl.search = new URLSearchParams({ provider: 'google', redirect_to: appRedirect,
  code_challenge: challenge, code_challenge_method: 's256', prompt: 'select_account', scopes: 'openid email profile' }).toString()
const request = (url, options = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...options })
const start = await request(authUrl, { headers: { apikey: key } })
const location = start.headers.get('location')
if (start.status !== 302 || !location) throw new Error(`OAuth start failed (HTTP ${start.status})`)
const google = new URL(location)
if (google.protocol !== 'https:' || google.hostname !== 'accounts.google.com') throw new Error('Unexpected OAuth provider destination')
const state = google.searchParams.get('state')
if (!state) throw new Error('Missing OAuth state')
const result = {
  project: new URL(base).hostname,
  oauthStartStatus: start.status,
  googleClientIdPresent: Boolean(google.searchParams.get('client_id')?.endsWith('.apps.googleusercontent.com')),
  googleCallbackMatches: google.searchParams.get('redirect_uri') === expectedCallback,
  accountSelectionRequested: google.searchParams.get('prompt') === 'select_account',
}
// An explicit denial exercises Supabase's configured return allowlist without
// obtaining a Google code or using the client secret to exchange any tokens.
const cancelUrl = new URL(expectedCallback)
cancelUrl.search = new URLSearchParams({ error: 'access_denied', error_description: 'Configuration check cancelled before sign-in', state }).toString()
const cancelled = await request(cancelUrl)
const returnLocation = cancelled.headers.get('location')
const returned = returnLocation ? new URL(returnLocation) : null
result.cancelStatus = cancelled.status
result.appReturnMatches = Boolean(returned && `${returned.protocol}//${returned.host}${returned.pathname}` === appRedirect)
result.returnedOriginAndPath = returned ? `${returned.protocol}//${returned.host}${returned.pathname}` : null
result.secretExchangeTested = false
result.note = 'No user signed in. Client Secret and device handoff need a real sign-in test.'
console.log(JSON.stringify(result, null, 2))
if (!result.googleClientIdPresent || !result.googleCallbackMatches || !result.appReturnMatches) process.exitCode = 1

// Read-only: checks public Auth capabilities, never sends SMS or changes users.
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : []
}))
const url = env.EXPO_PUBLIC_SUPABASE_URL
const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) throw new Error('Supabase public configuration missing')
const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
if (!response.ok) throw new Error(`Auth settings returned HTTP ${response.status}`)
const settings = await response.json()
console.log(JSON.stringify({
  project: new URL(url).hostname,
  phoneEnabled: settings.external?.phone,
  googleEnabled: settings.external?.google,
  anonymousEnabled: settings.external?.anonymous_users,
  smsAutoconfirm: settings.sms_autoconfirm,
  signupDisabled: settings.disable_signup,
  note: 'Twilio credentials and actual delivery require separate server-side verification.',
}, null, 2))

import { createClient } from 'jsr:@supabase/supabase-js@2'

const keyServerUrl = 'https://www.gstatic.com/admob/reward/verifier-keys.json'
const expectedAdUnit = '6544344118'
const expectedRewardAmount = '50'
const expectedRewardItem = 'points'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type VerifierKey = { keyId: number; base64: string }

const text = (body: string, status = 200) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
})

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}

const derEcdsaToRaw = (der: Uint8Array, size = 32) => {
  if (der[0] !== 0x30) throw new Error('invalid_signature_sequence')
  let offset = 1
  const sequenceLength = der[offset] === 0x81 ? der[++offset] : der[offset]
  offset += 1
  if (sequenceLength == null || offset + sequenceLength !== der.length || der[offset++] !== 0x02) {
    throw new Error('invalid_signature_length')
  }
  const rLength = der[offset++]
  if (rLength == null) throw new Error('invalid_signature_r')
  const r = der.slice(offset, offset + rLength)
  offset += rLength
  if (der[offset++] !== 0x02) throw new Error('invalid_signature_s_marker')
  const sLength = der[offset++]
  if (sLength == null) throw new Error('invalid_signature_s')
  const s = der.slice(offset, offset + sLength)

  const normalize = (integer: Uint8Array) => {
    let start = 0
    while (integer.length - start > size && integer[start] === 0) start += 1
    const value = integer.slice(start)
    if (value.length > size) throw new Error('invalid_signature_integer')
    const result = new Uint8Array(size)
    result.set(value, size - value.length)
    return result
  }
  const raw = new Uint8Array(size * 2)
  raw.set(normalize(r), 0)
  raw.set(normalize(s), size)
  return raw
}

async function verifySignature(rawQuery: string, signature: string, keyId: string) {
  const signatureMarker = '&signature='
  const signatureIndex = rawQuery.indexOf(signatureMarker)
  if (signatureIndex < 0) return false
  const signedContent = rawQuery.slice(0, signatureIndex)
  const keysResponse = await fetch(keyServerUrl)
  if (!keysResponse.ok) throw new Error(`admob_key_server_${keysResponse.status}`)
  const keyList = await keysResponse.json() as { keys?: VerifierKey[] }
  const verifierKey = keyList.keys?.find(key => String(key.keyId) === keyId)
  if (!verifierKey) throw new Error('unknown_admob_key')
  const publicKey = await crypto.subtle.importKey(
    'spki',
    Uint8Array.from(atob(verifierKey.base64), character => character.charCodeAt(0)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    derEcdsaToRaw(decodeBase64Url(signature)),
    new TextEncoder().encode(signedContent),
  )
}

Deno.serve(async request => {
  if (request.method !== 'GET') return text('method_not_allowed', 405)
  const requestUrl = new URL(request.url)
  const rawQuery = requestUrl.search.slice(1)
  const parameters = requestUrl.searchParams
  const signature = parameters.get('signature')
  const keyId = parameters.get('key_id')
  const transactionId = parameters.get('transaction_id')
  const userId = parameters.get('user_id')
  const timestamp = Number(parameters.get('timestamp'))
  if (!signature || !keyId || !transactionId || !Number.isFinite(timestamp)) {
    return text('invalid_callback', 400)
  }

  try {
    if (!await verifySignature(rawQuery, signature, keyId)) return text('invalid_signature', 401)
    // AdMob's URL verification callback can use synthetic reward parameters.
    // Accept only Google's valid signature plus this setup-only marker, and
    // never call the point-crediting function for it.
    if (parameters.get('custom_data') === 'admob_ssv_setup_test') return text('ok')
    if (parameters.get('ad_unit') !== expectedAdUnit || parameters.get('reward_amount') !== expectedRewardAmount || parameters.get('reward_item') !== expectedRewardItem) {
      return text('unexpected_reward', 400)
    }
    if (timestamp > Date.now() + 5 * 60_000 || timestamp < Date.now() - 24 * 60 * 60_000) {
      return text('expired_callback', 400)
    }
    if (!userId || !uuidPattern.test(userId) || parameters.get('custom_data') !== 'ingtalk_rewarded_50') {
      return text('invalid_reward_recipient', 400)
    }
    const url = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceRoleKey) return text('server_not_configured', 500)
    const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const payload = Object.fromEntries(parameters.entries())
    delete payload.signature
    const { error } = await admin.rpc('credit_verified_rewarded_ad', {
      target_user_id: userId,
      ad_provider: 'admob',
      ad_transaction_id: transactionId,
      verified_payload: payload,
    })
    if (error) throw error
    return text('ok')
  } catch (error) {
    console.error('admob-reward failed', { transactionId, error })
    return text('verification_failed', 500)
  }
})

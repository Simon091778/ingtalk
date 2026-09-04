/** @jest-environment node */
const { generateKeyPairSync, sign, webcrypto } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

// Exercise the actual Edge Function with real ECDSA signatures. Only the public
// key fetch and service-role database call are replaced; no live points are used.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const keyId = '12345'
const recipient = '10000000-0000-4000-8000-000000000001'
const ticket = '20000000-0000-4000-8000-000000000002'
const source = ts.transpileModule(readFileSync(resolve(__dirname, '../supabase/functions/admob-reward/index.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
let handler
const rpc = jest.fn()
const fetchKeys = jest.fn()

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null })
  fetchKeys.mockReset().mockResolvedValue(new Response(JSON.stringify({ keys: [{
    keyId: Number(keyId), base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }] })))
  runInNewContext(source, {
    exports: {},
    require: name => {
      if (name !== 'jsr:@supabase/supabase-js@2') throw new Error(`Unexpected dependency: ${name}`)
      return { createClient: () => ({ rpc }) }
    },
    Deno: { serve: callback => { handler = callback }, env: { get: () => 'test-only' } },
    crypto: webcrypto, fetch: fetchKeys, URL, Response, TextEncoder, Uint8Array, atob,
    console: { error: jest.fn() },
  })
})

function callback(overrides = {}, encode = value => value.replace(/:/g, '%3A')) {
  const values = {
    ad_network: '5450213213286189855', ad_unit: '6544344118',
    custom_data: `ingtalk_rewarded_v2:${ticket}`, reward_amount: '50', reward_item: 'points',
    timestamp: String(Date.now()), transaction_id: 'test-transaction', user_id: recipient, ...overrides,
  }
  const content = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('&')
  const signature = sign('sha256', Buffer.from(content), privateKey).toString('base64url')
  return `https://example.test/admob-reward?${encode(content)}&signature=${signature}&key_id=${keyId}`
}

test.each(['%3A', '%3a', ':'])('accepts a signed V2 ticket with colon representation %s', async colon => {
  const response = await handler(new Request(callback({}, value => value.replace(/:/g, colon))))
  expect(response.status).toBe(200)
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc).toHaveBeenCalledWith('credit_verified_rewarded_ad_resolved', expect.objectContaining({
    requested_user_id: recipient, ad_provider: 'admob',
    verified_payload: expect.objectContaining({ custom_data: `ingtalk_rewarded_v2:${ticket}` }),
  }))
  expect(rpc.mock.calls[0][1].verified_payload.signature).toBeUndefined()
  expect(fetchKeys).toHaveBeenCalledWith('https://www.gstatic.com/admob/reward/verifier-keys.json')
})

test('legacy callbacks remain valid', async () => {
  const response = await handler(new Request(callback({ custom_data: 'ingtalk_rewarded_50' })))
  expect(response.status).toBe(200)
  expect(rpc).toHaveBeenCalledTimes(1)
})

test('does not treat a literal plus as a space when verifying', async () => {
  expect((await handler(new Request(callback({ transaction_id: 'test+transaction' })))).status).toBe(200)
})

test.each([
  url => url.replace(recipient, '30000000-0000-4000-8000-000000000003'),
  url => url.replace(ticket, '40000000-0000-4000-8000-000000000004'),
  url => url.replace('reward_amount=50', 'reward_amount=500'),
  url => url.replace('%3A', '%253A'),
  url => url.replace('%3A', '%ZZ'),
  url => url.replace(/signature=[^&]+/, 'signature=AAAA'),
  url => url.replace(`key_id=${keyId}`, 'key_id=99999'),
])('rejects tampered or malformed callbacks %# without crediting', async tamper => {
  expect((await handler(new Request(tamper(callback())))).status).toBe(401)
  expect(rpc).not.toHaveBeenCalled()
})

test.each([
  { timestamp: String(Date.now() - 25 * 60 * 60_000) },
  { timestamp: String(Date.now() + 10 * 60_000) },
  { reward_amount: '500' },
  { ad_unit: 'wrong-unit' },
  { custom_data: 'ingtalk_rewarded_v2:invalid' },
])('rejects signed but ineligible callback %j', async values => {
  expect((await handler(new Request(callback(values)))).status).toBe(400)
  expect(rpc).not.toHaveBeenCalled()
})

test('setup callback never credits points', async () => {
  expect((await handler(new Request(callback({ custom_data: 'admob_ssv_setup_test' })))).status).toBe(200)
  expect(rpc).not.toHaveBeenCalled()
})

test('unsigned requests and wrong methods cannot credit points', async () => {
  expect((await handler(new Request('https://example.test/admob-reward'))).status).toBe(400)
  expect((await handler(new Request(callback(), { method: 'POST' }))).status).toBe(405)
  expect(rpc).not.toHaveBeenCalled()
})

test('database failures remain retryable without reporting success', async () => {
  rpc.mockResolvedValue({ error: { message: 'database unavailable' } })
  const response = await handler(new Request(callback()))
  expect(response.status).toBe(500)
})

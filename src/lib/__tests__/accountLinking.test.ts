import { accountLoginMethods, beginAccountLink, finishAccountLink, reauthorizeAccountSession, type AccountLinkRequest } from '../accountLinking'
jest.mock('../deviceAccountKey', () => ({ getDeviceAccountKey: async () => 'a'.repeat(64) }))
jest.mock('../deviceReinstallIdentity', () => ({ getDeviceReinstallIdentity: async () => ({ platform: 'android', identifier: 'b'.repeat(64) }) }))
const accountId = '10000000-0000-4000-8000-000000000001'
const request: AccountLinkRequest = { accountId, provider: 'google', ticket: 'c'.repeat(64), secret: 'a'.repeat(64), identity: { platform: 'android', identifier: 'b'.repeat(64) } }
test('begin rejects an unexpected source account rather than linking a changed session', async () => {
  const client: any = { rpc: async () => ({ data: { ok: true, ticket: request.ticket, provider: 'google', account_id: '10000000-0000-4000-8000-000000000002' } }) }
  await expect(beginAccountLink(client, accountId)).rejects.toThrow('invalid_account_response')
})
test('begin rejects malformed tickets', async () => {
  const client: any = { rpc: async () => ({ data: { ok: true, ticket: 'short', provider: 'google', account_id: accountId } }) }
  await expect(beginAccountLink(client, accountId)).rejects.toThrow('invalid_account_response')
})
test('finish cannot report success for a different account', async () => {
  const client: any = { rpc: async () => ({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000002' } }) }
  await expect(finishAccountLink(client, request)).rejects.toThrow('invalid_account_response')
})
test('finish accepts an authenticated recovery only when the server binds it to the requested empty account', async () => {
  const recoveredId = '10000000-0000-4000-8000-000000000002'
  const client: any = { rpc: async () => ({ data: {
    ok: true, account_id: accountId, recovered_account_id: recoveredId,
    previous_account_id: accountId, recovered_existing_account: true,
  } }) }
  await expect(finishAccountLink(client, request)).resolves.toEqual({ accountId: recoveredId, recoveredExistingAccount: true })
  client.rpc = async () => ({ data: { ok: true, account_id: accountId, recovered_account_id: recoveredId,
    previous_account_id: recoveredId, recovered_existing_account: true } })
  await expect(finishAccountLink(client, request)).rejects.toThrow('invalid_account_response')
})
test.each([
  ['point_spent', 'manual_merge_activity'],
  ['ledger_mismatch', 'manual_merge_accounting'],
])('finish maps protected recovery reason %s without exposing account identifiers', async (reason, expected) => {
  const client: any = { rpc: async () => ({ data: { error: 'manual_merge_required', reason } }) }
  await expect(finishAccountLink(client, request)).rejects.toThrow(expected)
})
test('reauthentication promotes a fresh phone session only after the server confirms the same app account', async () => {
  const setSession = jest.fn().mockResolvedValue({ error: null })
  const main: any = { auth: { setSession } }
  const proof: any = {
    auth: { getSession: async () => ({ error: null, data: { session: {
      access_token: 'fresh-access', refresh_token: 'fresh-refresh',
      user: { app_metadata: { provider: 'phone' }, identities: [] },
    } } }) },
    rpc: jest.fn().mockResolvedValue({ data: { ok: true, account_id: accountId, created: false, restored: false } }),
  }
  await expect(reauthorizeAccountSession(main, proof, accountId)).resolves.toBe('phone')
  expect(proof.rpc).toHaveBeenCalledWith('authorize_device_account_v2', expect.objectContaining({ device_secret: 'a'.repeat(64) }))
  expect(setSession).toHaveBeenCalledWith({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' })
  proof.rpc.mockResolvedValue({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000002', created: true, restored: false } })
  await expect(reauthorizeAccountSession(main, proof, accountId)).rejects.toThrow('account_link_conflict')
  expect(setSession).toHaveBeenCalledTimes(1)
})
test.each([{ providers: [] }, { providers: ['google', 'google'] }, { providers: ['apple'] }])('method list rejects invalid providers %j', async ({ providers }) => {
  const client: any = { rpc: async () => ({ data: { account_id: accountId, providers } }) }
  await expect(accountLoginMethods(client)).rejects.toThrow('invalid_account_response')
})

test('all three supported providers are accepted', async () => {
  const client: any = { rpc: async () => ({ data: { account_id: accountId, providers: ['phone', 'google', 'kakao'] } }) }
  expect((await accountLoginMethods(client)).providers).toEqual(['phone', 'google', 'kakao'])
})

test('explicit Kakao target uses v2 and rejects a different returned provider', async () => {
  const client: any = { rpc: jest.fn().mockResolvedValue({ data: { ok: true, account_id: accountId, ticket: request.ticket, provider: 'kakao' } }) }
  expect((await beginAccountLink(client, accountId, 'kakao')).provider).toBe('kakao')
  expect(client.rpc).toHaveBeenCalledWith('begin_account_link_v2', expect.objectContaining({ target_provider: 'kakao' }))
  client.rpc.mockResolvedValue({ data: { ok: true, account_id: accountId, ticket: request.ticket, provider: 'google' } })
  await expect(beginAccountLink(client, accountId, 'kakao')).rejects.toThrow('invalid_account_response')
})

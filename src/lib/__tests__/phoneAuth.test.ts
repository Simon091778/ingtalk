import { authorizeDeviceAccount, authErrorText, getAccountId, normalizePhone, phoneInputValue, signOutAccount } from '../phoneAuth'
import { activateLocalAccount } from '../accountLocalState'

const accountId = '10000000-0000-4000-8000-000000000001'
test('new account cannot inherit the previous accounts locally saved message or profile', () => {
  const drafts = ['ingtalk.guest-profile.v1', 'ingtalk.last-sent-request-message.v1', 'ingtalk.last-published-talk-card.v1']
  activateLocalAccount(accountId)
  drafts.forEach(key => localStorage.setItem(key, 'private draft'))
  activateLocalAccount(accountId)
  drafts.forEach(key => expect(localStorage.getItem(key)).toBe('private draft'))
  activateLocalAccount('10000000-0000-4000-8000-000000000002')
  drafts.forEach(key => expect(localStorage.getItem(key)).toBeNull())
})
test('normalizes Korean mobile and international E.164 without guessing overseas numbers', () => {
  expect(normalizePhone('010-1234-5678')).toBe('+821012345678')
  expect(normalizePhone('+82 10-1234-5678')).toBe('+821012345678')
  expect(normalizePhone('821012345678')).toBe('+821012345678')
  expect(phoneInputValue('+821012345678')).toBe('01012345678')
  expect(phoneInputValue('821012345678')).toBe('01012345678')
  expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123')
  for (const number of ['4155550123', '010abc12345678', '+0123456789', '+82', '']) expect(() => normalizePhone(number)).toThrow()
})
test('uses server principal, never the phone Auth user ID', async () => {
  const client = { auth: { getSession: jest.fn() }, rpc: jest.fn().mockResolvedValue({ data: accountId }) }
  expect(await getAccountId(client as never)).toBe(accountId)
  expect(client.rpc).toHaveBeenCalledWith('current_account_id')
  expect(client.auth.getSession).not.toHaveBeenCalled()
  client.rpc.mockResolvedValue({ data: null })
  expect(await getAccountId(client as never)).toBeNull()
})
test.each([undefined, '', {}, { id: accountId }, 'not-a-uuid'])('malformed principal fails closed (%p)', async data => {
  await expect(getAccountId({ rpc: async () => ({ data }) } as never)).rejects.toThrow('invalid_account_response')
})
test('automatic authorization validates response and sends the saved key only to its RPC', async () => {
  const client = { rpc: jest.fn().mockResolvedValue({ data: { ok: true, account_id: accountId, created: false } }) }
  expect((await authorizeDeviceAccount(client as never, 'a'.repeat(64))).account_id).toBe(accountId)
  expect(client.rpc).toHaveBeenCalledWith('authorize_device_account', { device_secret: 'a'.repeat(64) })
  client.rpc.mockResolvedValue({ data: { error: 'reauthenticate_required' } })
  await expect(authorizeDeviceAccount(client as never, '')).rejects.toThrow('reauthenticate_required')
  client.rpc.mockResolvedValue({ data: { ok: true } })
  await expect(authorizeDeviceAccount(client as never, '')).rejects.toThrow('invalid_account_response')
  client.rpc.mockResolvedValue({ error: new Error('sensitive provider error') })
  await expect(authorizeDeviceAccount(client as never, '')).rejects.toThrow('account_service_unavailable')
  expect(authErrorText(new Error('phone-01012345678'))).not.toContain('01012345678')
  expect(authErrorText(new Error('link_reauthentication_required'))).not.toContain('로그아웃')
  expect(authErrorText(new Error('manual_merge_required'))).toContain('자동으로 연결할 수 없어요')
  expect(authErrorText(new Error('phone_identity_conflict'))).toContain('계정을 합치거나 삭제하지 않았으며')
  expect(authErrorText(new Error('otp_verification_failed'))).toContain('올바르지 않거나 만료되었습니다')
  expect(authErrorText(new Error('account_service_unavailable'))).toContain('인증은 완료됐지만 계정 정보를')
})
test('logout revokes the server grant before clearing only this Auth session', async () => {
  const order: string[] = []
  const client = {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { user: { id: 'AuthID' } } } }),
      signOut: jest.fn().mockImplementation(async () => { order.push('signOut'); return {} }),
    },
    rpc: jest.fn().mockImplementation(async () => { order.push('revoke'); return {} }),
  }
  await signOutAccount(client as never)
  expect(order).toEqual(['revoke', 'signOut'])
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(client.rpc).toHaveBeenCalledWith('lock_account_session')
  client.auth.signOut.mockClear()
  client.rpc.mockResolvedValue({ error: new Error('offline') })
  await expect(signOutAccount(client as never)).rejects.toThrow('account_service_unavailable')
  expect(client.auth.signOut).not.toHaveBeenCalled()
})
test('reinstall authorization sends separate native binding and validates restoration result', async () => {
  const identity = { platform: 'android' as const, identifier: 'b'.repeat(64) }
  const client = { rpc: jest.fn().mockResolvedValue({ data: { ok: true, account_id: accountId, created: false, restored: true } }) }
  expect((await authorizeDeviceAccount(client as never, 'a'.repeat(64), identity)).restored).toBe(true)
  expect(client.rpc).toHaveBeenCalledWith('authorize_device_account_v2', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: identity.identifier })
  client.rpc.mockResolvedValue({ data: { ok: true, account_id: accountId, created: false } })
  await expect(authorizeDeviceAccount(client as never, 'a'.repeat(64), identity)).rejects.toThrow('invalid_account_response')
})

import { Linking, Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { signInWithKakao, kakaoCallbackCode, KAKAO_REDIRECT } from '../kakaoAuth'

const mockCreate = jest.fn()
const mockBrowser = jest.fn()
const mockKey = jest.fn()
const mockIdentity = jest.fn()
const mockCapture = jest.fn()
const mockRemoveLink = jest.fn()
let linkHandler: (event: { url: string }) => void
jest.mock('../observability', () => ({ addAppBreadcrumb: jest.fn(), captureAppError: (...args: unknown[]) => mockCapture(...args) }))
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreate(...args) }))
jest.mock('expo-web-browser', () => ({ WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss' }, openAuthSessionAsync: (...args: unknown[]) => mockBrowser(...args), openBrowserAsync: (...args: unknown[]) => mockBrowser(...args) }))
jest.mock('../deviceAccountKey', () => ({ getDeviceAccountKey: () => mockKey() }))
jest.mock('../deviceReinstallIdentity', () => ({ getDeviceReinstallIdentity: () => mockIdentity() }))
const originalPlatform = Platform.OS
const originalEnvironment = Constants.executionEnvironment
const originalFetch = globalThis.fetch
const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
const originalKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const session = { access_token: 'access', refresh_token: 'refresh', user: { app_metadata: { provider: 'kakao' }, identities: [{ provider: 'kakao' }] } }
let client: any
let target: any
beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Linking, 'addEventListener').mockImplementation((_event, handler) => {
    linkHandler = handler
    return { remove: mockRemoveLink } as unknown as ReturnType<typeof Linking.addEventListener>
  })
  Object.assign(Platform, { OS: 'android' })
  Object.assign(Constants, { executionEnvironment: ExecutionEnvironment.Standalone })
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'public-key'
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ external: { kakao: true } }) })
  mockKey.mockResolvedValue('a'.repeat(64))
  mockIdentity.mockResolvedValue({ platform: 'android', identifier: 'b'.repeat(64) })
  mockBrowser.mockImplementation(async () => {
    if (Platform.OS === 'ios') return { type: 'success', url: `${KAKAO_REDIRECT}?code=one-time-code` }
    linkHandler({ url: `${KAKAO_REDIRECT}?code=one-time-code` })
    return { type: 'opened' }
  })
  client = { auth: {
    signInWithOAuth: jest.fn().mockResolvedValue({ data: { url: 'https://example.supabase.co/auth/v1/authorize' } }),
    exchangeCodeForSession: jest.fn().mockResolvedValue({ data: { session } }),
    signOut: jest.fn().mockResolvedValue({}), stopAutoRefresh: jest.fn().mockResolvedValue(undefined),
  }, rpc: jest.fn().mockResolvedValue({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } }) }
  target = { auth: { setSession: jest.fn().mockResolvedValue({}) } }
  mockCreate.mockReturnValue(client)
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  Object.assign(Platform, { OS: originalPlatform })
  Object.assign(Constants, { executionEnvironment: originalEnvironment })
  globalThis.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL
  else process.env.EXPO_PUBLIC_SUPABASE_URL = originalUrl
  if (originalKey === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  else process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey
})

test('exchanges PKCE then authorizes the device before persisting the Kakao session', async () => {
  const signedIn = await signInWithKakao(target)
  expect(signedIn).toBe(true)
  expect(mockCreate.mock.calls[0][2].auth.flowType).toBe('pkce')
  expect(client.auth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'kakao', options: expect.objectContaining({ redirectTo: KAKAO_REDIRECT, skipBrowserRedirect: true }) }))
  const options = client.auth.signInWithOAuth.mock.calls[0][0].options
  expect(options.scopes).toBeUndefined()
  expect(options.queryParams).toEqual({ scope: '', prompt: 'login' })
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('one-time-code')
  expect(client.rpc).toHaveBeenCalledWith('authorize_kakao_device_account', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) })
  expect(client.rpc.mock.invocationCallOrder[0]!).toBeLessThan(target.auth.setSession.mock.invocationCallOrder[0]!)
  expect(target.auth.setSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
  expect(client.auth.signOut).not.toHaveBeenCalled()
  expect(mockBrowser).toHaveBeenCalledWith(expect.any(String), { createTask: false })
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
})

test('Android waits for an external Kakao callback, then cleans up', async () => {
  jest.useFakeTimers()
  mockBrowser.mockImplementation(async () => {
    setTimeout(() => linkHandler({ url: `${KAKAO_REDIRECT}?code=late-code` }), 100)
    return { type: 'opened' }
  })
  const signingIn = signInWithKakao(target)
  await jest.advanceTimersByTimeAsync(100)
  expect(await signingIn).toBe(true)
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('late-code')
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test('Android callback received before browser launch resolves is not lost or exchanged twice', async () => {
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: `${KAKAO_REDIRECT}?code=early-code` })
    linkHandler({ url: `${KAKAO_REDIRECT}?code=early-code` })
    return { type: 'opened' }
  })
  await expect(signInWithKakao(target)).resolves.toBe(true)
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1)
})

test('five-minute timeout without a matching callback reports interruption without changing accounts', async () => {
  jest.useFakeTimers()
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: 'ingtalk://auth/google?code=foreign' })
    linkHandler({ url: 'ingtalk://auth/kakao-extra?code=foreign' })
    linkHandler({ url: 'not a url' })
    return { type: 'opened' }
  })
  const signingIn = expect(signInWithKakao(target)).rejects.toThrow('social_auth_timeout')
  await jest.advanceTimersByTimeAsync(5 * 60_000)
  await signingIn
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
  expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'social_auth_timeout' }), 'auth', 'kakao_sign_in', { stage: 'browser_return', platform: 'android' })
})

test('a late callback still cannot bypass validation or promote a session after leaving', async () => {
  let active = true
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: `${KAKAO_REDIRECT}?code=late-code` })
    active = false
    return { type: 'opened' }
  })
  await expect(signInWithKakao(target, () => active)).resolves.toBe(false)
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
})

test('callback errors remain failures in the Android browser callback path', async () => {
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: `${KAKAO_REDIRECT}?error=denied&error_description=private-value` })
    return { type: 'opened' }
  })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_auth_failed')
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'kakao_auth_failed' }), 'auth', 'kakao_sign_in', { stage: 'code_exchange', platform: 'android' })
  expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('private-value')
})

test('iOS retains the native auth session without Android options or extra listeners', async () => {
  Object.assign(Platform, { OS: 'ios' })
  await expect(signInWithKakao(target)).resolves.toBe(true)
  expect(mockBrowser).toHaveBeenCalledWith(expect.any(String), KAKAO_REDIRECT)
  expect(Linking.addEventListener).not.toHaveBeenCalled()
})

test('browser launch failures remove listeners and never log raw provider errors', async () => {
  mockBrowser.mockRejectedValueOnce(new Error('private-provider-url-and-token'))
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_auth_failed')
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('private-provider')
})

test('cancel leaves the main phone session untouched', async () => {
  mockBrowser.mockResolvedValue({ type: 'cancel' })
  await expect(signInWithKakao(target)).resolves.toBe(false)
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
})

test.each(['https://evil.invalid/?code=abc', 'ingtalk://auth/other?code=abc', 'ingtalk://auth/kakao?code=a&code=b', 'ingtalk://auth/kakao#access_token=abc', 'ingtalk://auth/kakao?error=denied'])('rejects unexpected callback %s', callback => {
  expect(() => kakaoCallbackCode(callback)).toThrow('kakao_auth_failed')
})

test('does not persist sessions rejected by server device authorization', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'device_binding_mismatch' } })
  await expect(signInWithKakao(target)).rejects.toThrow('device_binding_mismatch')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('rejects automatically linked identities instead of merging phone points', async () => {
  client.auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { ...session, user: { ...session.user, identities: [{ provider: 'kakao' }, { provider: 'phone' }] } } } })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_identity_conflict')
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
})

test('checks configuration and device storage before opening a browser', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ external: { kakao: false } }) })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_not_configured')
  expect(mockBrowser).not.toHaveBeenCalled()
})

test('Expo Go does not start an unsupported OAuth redirect', async () => {
  Object.assign(Constants, { executionEnvironment: ExecutionEnvironment.StoreClient })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_native_required')
  expect(mockCreate).not.toHaveBeenCalled()
})

test('a late callback cannot sign in after leaving the active gate', async () => {
  let active = true
  mockBrowser.mockImplementation(async () => { active = false; linkHandler({ url: `${KAKAO_REDIRECT}?code=late` }); return { type: 'opened' } })
  await expect(signInWithKakao(target, () => active)).resolves.toBe(false)
  expect(target.auth.setSession).not.toHaveBeenCalled()
})

test('linking consumes the isolated proof without creating an account or replacing the main session', async () => {
  const consume = jest.fn().mockResolvedValue(undefined)
  const result = await signInWithKakao(target, () => true, consume)
  expect(result).toBe(true)
  expect(consume).toHaveBeenCalledWith(client)
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('a conflicting link leaves the original session untouched and closes the temporary proof', async () => {
  await expect(signInWithKakao(target, () => true, async () => { throw new Error('account_link_conflict') })).rejects.toThrow('account_link_conflict')
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('a protected phone-account recovery error is not rewritten as a Kakao login failure', async () => {
  await expect(signInWithKakao(target, () => true, async () => { throw new Error('manual_merge_required') })).rejects.toThrow('manual_merge_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('occupied-device login is reported without persisting an unauthorized Kakao session', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'account_link_required' } })
  await expect(signInWithKakao(target)).rejects.toThrow('account_link_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(mockCapture).not.toHaveBeenCalled()
})

test('ambiguous historical Kakao accounts do not promote an arbitrary account session', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'account_resolution_required' } })
  await expect(signInWithKakao(target)).rejects.toThrow('account_resolution_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('unexpected Kakao email fails closed before authorization or session promotion', async () => {
  client.auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { ...session, user: { ...session.user, email: 'private@example.invalid' } } } })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_privacy_configuration')
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('Google callback cannot complete Kakao login', async () => {
  Object.assign(Platform, { OS: 'ios' })
  mockBrowser.mockResolvedValue({ type: 'success', url: 'ingtalk://auth/google?code=wrong-provider' })
  await expect(signInWithKakao(target)).rejects.toThrow('kakao_auth_failed')
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
})

test('Google cannot start concurrently with a pending Kakao browser session', async () => {
  const { signInWithGoogle } = require('../googleAuth')
  let cancel!: (value: unknown) => void
  mockBrowser.mockImplementation(() => new Promise(resolve => { cancel = resolve }))
  const running = signInWithKakao(target)
  // Wait for the first browser request, not an arbitrary timer.
  for (let n = 0; n < 20 && !cancel; n++) await Promise.resolve()
  expect(typeof cancel).toBe('function')
  expect(await signInWithGoogle(target)).toBe(false)
  cancel({ type: 'cancel' })
  expect(await running).toBe(false)
  expect(mockBrowser).toHaveBeenCalledTimes(1)
})

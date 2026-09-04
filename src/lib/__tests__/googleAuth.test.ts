import { AppState, Linking, Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { signInWithGoogle, googleCallbackCode, GOOGLE_REDIRECT } from '../googleAuth'
import { addAppBreadcrumb, captureAppError } from '../observability'

const mockCreate = jest.fn()
const mockBrowser = jest.fn()
const mockKey = jest.fn()
const mockIdentity = jest.fn()
const mockRemoveLink = jest.fn()
let linkHandler: (event: { url: string }) => void
jest.mock('../observability', () => ({ addAppBreadcrumb: jest.fn(), captureAppError: jest.fn() }))
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreate(...args) }))
jest.mock('expo-web-browser', () => ({ WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss' }, openAuthSessionAsync: (...args: unknown[]) => mockBrowser(...args), openBrowserAsync: (...args: unknown[]) => mockBrowser(...args) }))
jest.mock('../deviceAccountKey', () => ({ getDeviceAccountKey: () => mockKey() }))
jest.mock('../deviceReinstallIdentity', () => ({ getDeviceReinstallIdentity: () => mockIdentity() }))
const originalPlatform = Platform.OS
const originalEnvironment = Constants.executionEnvironment
const originalFetch = globalThis.fetch
const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
const originalKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const session = { access_token: 'access', refresh_token: 'refresh', user: { app_metadata: { provider: 'google' }, identities: [{ provider: 'google' }] } }
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
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ external: { google: true } }) })
  mockKey.mockResolvedValue('a'.repeat(64))
  mockIdentity.mockResolvedValue({ platform: 'android', identifier: 'b'.repeat(64) })
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: `${GOOGLE_REDIRECT}?code=one-time-code` })
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

test('exchanges PKCE then authorizes the device before persisting the Google session', async () => {
  const signedIn = await signInWithGoogle(target)
  expect(signedIn).toBe(true)
  expect(mockCreate.mock.calls[0][2].auth.flowType).toBe('pkce')
  expect(client.auth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', options: expect.objectContaining({ redirectTo: GOOGLE_REDIRECT, skipBrowserRedirect: true }) }))
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('one-time-code')
  expect(client.rpc).toHaveBeenCalledWith('authorize_google_device_account', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) })
  expect(client.rpc.mock.invocationCallOrder[0]!).toBeLessThan(target.auth.setSession.mock.invocationCallOrder[0]!)
  expect(target.auth.setSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
  expect(client.auth.signOut).not.toHaveBeenCalled()
  expect(mockBrowser).toHaveBeenCalledWith(expect.any(String), { createTask: false })
})

test('adding a Google account can take longer than two seconds without foreground cancelling auth', async () => {
  jest.useFakeTimers()
  const appStateListener = jest.spyOn(AppState, 'addEventListener')
  mockBrowser.mockResolvedValue({ type: 'opened' })
  let settled = false
  const signingIn = signInWithGoogle(target).then(result => { settled = true; return result })
  await jest.advanceTimersByTimeAsync(30_000)
  expect(settled).toBe(false)
  expect(appStateListener).not.toHaveBeenCalled()
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  linkHandler({ url: `${GOOGLE_REDIRECT}?code=new-account-proof` })
  expect(await signingIn).toBe(true)
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('new-account-proof')
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test('explicit cancellation removes the listener, ignores late callbacks and releases the login lock', async () => {
  jest.useFakeTimers()
  const controller = new AbortController()
  mockBrowser.mockResolvedValue({ type: 'opened' })
  const signingIn = signInWithGoogle(target, () => true, undefined, controller.signal)
  await jest.advanceTimersByTimeAsync(100)
  const oldHandler = linkHandler
  controller.abort()
  expect(await signingIn).toBe(false)
  oldHandler({ url: `${GOOGLE_REDIRECT}?code=cancelled-proof` })
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(mockRemoveLink).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
  mockBrowser.mockImplementation(async () => {
    linkHandler({ url: `${GOOGLE_REDIRECT}?code=retry-proof` })
    return { type: 'opened' }
  })
  await expect(signInWithGoogle(target)).resolves.toBe(true)
  expect(client.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1)
})

test('cancel during code exchange cannot enroll or persist the verified account', async () => {
  const controller = new AbortController()
  client.auth.exchangeCodeForSession.mockImplementation(async () => {
    controller.abort()
    return { data: { session } }
  })
  await expect(signInWithGoogle(target, () => true, undefined, controller.signal)).resolves.toBe(false)
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
})

test('cancel leaves the main phone session untouched', async () => {
  mockBrowser.mockResolvedValue({ type: 'cancel' })
  await expect(signInWithGoogle(target)).resolves.toBe(false)
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled()
})

test.each(['https://evil.invalid/?code=abc', 'ingtalk://auth/other?code=abc', 'ingtalk://auth/google?code=a&code=b', 'ingtalk://auth/google#access_token=abc', 'ingtalk://auth/google?error=denied'])('rejects unexpected callback %s', callback => {
  expect(() => googleCallbackCode(callback)).toThrow('google_auth_failed')
})

test('does not persist sessions rejected by server device authorization', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'device_binding_mismatch' } })
  await expect(signInWithGoogle(target)).rejects.toThrow('device_binding_mismatch')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('rejects automatically linked identities instead of merging phone points', async () => {
  client.auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { ...session, user: { ...session.user, identities: [{ provider: 'google' }, { provider: 'phone' }] } } } })
  await expect(signInWithGoogle(target)).rejects.toThrow('google_identity_conflict')
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
})

test('checks configuration and device storage before opening a browser', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ external: { google: false } }) })
  await expect(signInWithGoogle(target)).rejects.toThrow('google_not_configured')
  expect(mockBrowser).not.toHaveBeenCalled()
})

test('Expo Go does not start an unsupported OAuth redirect', async () => {
  Object.assign(Constants, { executionEnvironment: ExecutionEnvironment.StoreClient })
  await expect(signInWithGoogle(target)).rejects.toThrow('google_native_required')
  expect(mockCreate).not.toHaveBeenCalled()
})

test('a late callback cannot sign in after leaving the active gate', async () => {
  let active = true
  mockBrowser.mockImplementation(async () => { active = false; linkHandler({ url: `${GOOGLE_REDIRECT}?code=late` }); return { type: 'opened' } })
  await expect(signInWithGoogle(target, () => active)).resolves.toBe(false)
  expect(target.auth.setSession).not.toHaveBeenCalled()
})

test('linking consumes the isolated proof without creating an account or replacing the main session', async () => {
  const consume = jest.fn().mockResolvedValue(undefined)
  const result = await signInWithGoogle(target, () => true, consume)
  expect(result).toBe(true)
  expect(consume).toHaveBeenCalledWith(client)
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('a conflicting link leaves the original session untouched and closes the temporary proof', async () => {
  await expect(signInWithGoogle(target, () => true, async () => { throw new Error('account_link_conflict') })).rejects.toThrow('account_link_conflict')
  expect(client.rpc).not.toHaveBeenCalled()
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('a protected phone-account recovery error is not rewritten as a Google login failure', async () => {
  await expect(signInWithGoogle(target, () => true, async () => { throw new Error('manual_merge_required') })).rejects.toThrow('manual_merge_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('legacy-server linking requirement is reported without persisting an unauthorized Google session', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'account_link_required' } })
  await expect(signInWithGoogle(target)).rejects.toThrow('account_link_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(captureAppError).not.toHaveBeenCalled()
  expect(addAppBreadcrumb).toHaveBeenCalledWith('social_auth_account_link_required', { provider: 'google', stage: 'device_authorization', platform: 'android' })
})

test('server switch limit cannot persist a session or cover guidance with LogBox', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'account_switch_rate_limited' } })
  await expect(signInWithGoogle(target)).rejects.toThrow('account_switch_rate_limited')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(captureAppError).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('ambiguous historical Google accounts are reported without selecting or persisting a wallet', async () => {
  client.rpc.mockResolvedValue({ data: { error: 'account_resolution_required' } })
  await expect(signInWithGoogle(target)).rejects.toThrow('account_resolution_required')
  expect(target.auth.setSession).not.toHaveBeenCalled()
  expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

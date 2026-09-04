import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { Alert, Modal, ScrollView } from 'react-native'
import { AccountSessionSettings } from '../AccountSessionSettings'
import { AccountLinkDialog } from '../AccountLinkDialog'
import { AccountSwitchButton } from '../AccountSwitchButton'
import type { AccountLinkRequest } from '../../lib/accountLinking'

const mockMainRpc = jest.fn()
const mockProofRpc = jest.fn()
const mockSend = jest.fn()
const mockVerify = jest.fn()
const mockProofSignOut = jest.fn()
const mockMainSignOut = jest.fn()
const mockMainGetSession = jest.fn()
const mockMainSetSession = jest.fn()
const mockProofGetSession = jest.fn()
const mockGoogle = jest.fn()
const mockKakao = jest.fn()
const mockCreate = jest.fn()
const mockStop = jest.fn()
const mockExpoGoTesting = jest.fn()
const accountId = '10000000-0000-4000-8000-000000000001'
const proof: any = { rpc: (...args: unknown[]) => mockProofRpc(...args), auth: {
  signInWithOtp: (...args: unknown[]) => mockSend(...args), verifyOtp: (...args: unknown[]) => mockVerify(...args),
  getSession: (...args: unknown[]) => mockProofGetSession(...args),
  signOut: (...args: unknown[]) => mockProofSignOut(...args), stopAutoRefresh: async () => {},
} }
jest.mock('../../i18n', () => ({ useI18n: () => ({ language: 'ko' }) }))
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View, SafeAreaProvider: jest.requireActual('react-native').View }))
jest.mock('../SwipeDismissView', () => ({ SwipeDismissView: ({ children, ...props }: any) =>
  require('react').createElement(require('react-native').View, { testID: 'account-back-swipe', ...props }, children) }))
jest.mock('../../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockMainRpc(...args), auth: {
  getSession: (...args: unknown[]) => mockMainGetSession(...args),
  setSession: (...args: unknown[]) => mockMainSetSession(...args),
  signOut: (...args: unknown[]) => mockMainSignOut(...args),
} } }))
jest.mock('../../lib/expoGoAuth', () => ({ isExpoGoAuthTesting: () => mockExpoGoTesting() }))
jest.mock('../../lib/googleAuth', () => ({ signInWithGoogle: (...args: unknown[]) => mockGoogle(...args) }))
jest.mock('../../lib/kakaoAuth', () => ({ signInWithKakao: (...args: unknown[]) => mockKakao(...args) }))
jest.mock('../../lib/deviceAccountKey', () => ({ getDeviceAccountKey: async () => 'a'.repeat(64) }))
jest.mock('../../lib/deviceReinstallIdentity', () => ({ getDeviceReinstallIdentity: async () => ({ platform: 'android', identifier: 'b'.repeat(64) }) }))
jest.mock('../../lib/smsCodeAutofill', () => ({ prepareSmsCodeAutofill: async () => mockStop }))
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreate(...args) }))
const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
const originalKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
let providers: string[]
beforeEach(() => {
  jest.clearAllMocks()
  mockExpoGoTesting.mockReturnValue(false)
  providers = ['phone']
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'public-key'
  mockMainRpc.mockImplementation(async (name: string, args: any) => name === 'account_login_methods'
    ? { data: { account_id: accountId, providers } }
    : name === 'lock_account_session' ? { error: null }
    : { data: { ok: true, account_id: accountId, provider: args.target_provider, ticket: 'c'.repeat(64) } })
  mockMainSignOut.mockResolvedValue({ error: null })
  mockProofRpc.mockImplementation(async (name: string) => name.startsWith('authorize_')
    ? { data: { ok: true, account_id: accountId, created: false, restored: false } }
    : { data: { ok: true, account_id: accountId } })
  mockSend.mockResolvedValue({ error: null })
  mockVerify.mockResolvedValue({ error: null, data: { session: { access_token: 'proof-access', refresh_token: 'proof-refresh' } } })
  mockMainGetSession.mockResolvedValue({ error: null, data: { session: { user: { id: 'verified-user', phone: '+821012345678', app_metadata: { provider: 'phone' }, identities: [] } } } })
  mockProofGetSession.mockResolvedValue({ error: null, data: { session: {
    access_token: 'proof-access', refresh_token: 'proof-refresh', user: { id: 'verified-user', phone: '+821012345678', app_metadata: { provider: 'phone' }, identities: [] },
  } } })
  mockMainSetSession.mockResolvedValue({ error: null })
  mockProofSignOut.mockResolvedValue({ error: null })
  mockCreate.mockReturnValue(proof)
  mockGoogle.mockImplementation(async (_main: unknown, active: () => boolean, consume: (client: any) => Promise<void>) => {
    if (!active()) return false
    await consume(proof)
    return true
  })
  mockKakao.mockImplementation(mockGoogle.getMockImplementation()!)
})
afterEach(() => {
  jest.restoreAllMocks()
  if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL
  else process.env.EXPO_PUBLIC_SUPABASE_URL = originalUrl
  if (originalKey === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  else process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey
})

test('account switch requires confirmation and revokes only the current session first', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  render(<AccountSwitchButton />)
  fireEvent.press(screen.getByRole('button', { name: '다른 계정으로 로그인' }))
  expect(mockMainSignOut).not.toHaveBeenCalled()
  const actions = alert.mock.calls[0]![2]!
  expect(actions[0]!.style).toBe('cancel')
  expect(alert.mock.calls[0]![1]).toContain('자동으로 합쳐지지 않습니다')
  act(() => actions[1]!.onPress!())
  await waitFor(() => expect(mockMainSignOut).toHaveBeenCalledWith({ scope: 'local' }))
  expect(mockMainRpc).toHaveBeenCalledWith('lock_account_session')
  expect(mockMainRpc.mock.invocationCallOrder[0]).toBeLessThan(mockMainSignOut.mock.invocationCallOrder[0]!)
})

test('pre-profile account switch explains recovering the old account without creating a new profile', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  render(<AccountSwitchButton beforeProfile />)
  fireEvent.press(screen.getByRole('button', { name: '기존 계정으로 로그인' }))
  expect(alert.mock.calls[0]![1]).toContain('새 프로필을 만들기 전에')
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('account switch fails closed if server logout fails and ignores a stale confirmation after unmount', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  mockMainRpc.mockResolvedValue({ error: new Error('offline') })
  const view = render(<AccountSwitchButton />)
  fireEvent.press(screen.getByRole('button', { name: '다른 계정으로 로그인' }))
  const confirm = alert.mock.calls[0]![2]![1]!.onPress!
  act(() => confirm())
  await waitFor(() => expect(alert).toHaveBeenLastCalledWith('계정 전환 실패', expect.any(String)))
  expect(mockMainSignOut).not.toHaveBeenCalled()
  view.unmount()
  act(() => confirm())
  expect(mockMainRpc).toHaveBeenCalledTimes(1)
})

test('My Info shows only the account menu and loads its contents when opened', async () => {
  render(<AccountSessionSettings />)
  expect(screen.getByRole('button', { name: '로그인 및 계정 관리' })).toBeTruthy()
  expect(screen.queryByText('로그인 수단 연결')).toBeNull()
  expect(screen.queryByText('로그아웃')).toBeNull()
  expect(mockMainRpc).not.toHaveBeenCalled()
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  expect(screen.getByText('로그인 수단 연결')).toBeTruthy()
  expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy()
  const body = screen.UNSAFE_getByType(ScrollView)
  expect(within(body).getByText('로그인 수단 연결')).toBeTruthy()
  expect(within(body).queryByRole('button', { name: '내 정보로 돌아가기' })).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '내 정보로 돌아가기' }))
  expect(screen.queryByText('로그아웃')).toBeNull()
  providers = ['phone', 'google']
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 · Google 연결됨')
  fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose')
  expect(screen.queryByText('로그인 수단 연결')).toBeNull()
})

test('Expo Go shares the standalone account layout and keeps recovery limitations in the sign-out confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  // Compare rendered content and styles, not callbacks or per-mount native IDs.
  const layout = (tree: unknown) => JSON.parse(JSON.stringify(tree, (key, value) => key === 'identifier' ? undefined : value))
  const standalone = render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  const standaloneLayout = layout(standalone.toJSON())
  standalone.unmount()

  mockExpoGoTesting.mockReturnValue(true)
  const expoGo = render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  expect(layout(expoGo.toJSON())).toEqual(standaloneLayout)
  expect(screen.queryByText(/Expo Go/)).toBeNull()

  fireEvent.press(screen.getByRole('button', { name: '로그아웃' }))
  expect(alert.mock.calls[0]![1]).toContain('재설치 복구와 정식 앱으로의 포인트 이전을 지원하지 않습니다')
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test.each([false, true])('back swipe returns to My Info without signing out (Expo Go: %s)', async expoGo => {
  mockExpoGoTesting.mockReturnValue(expoGo)
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  const swipe = screen.getByTestId('account-back-swipe')
  expect(swipe.props.enabled).toBe(true)
  expect(swipe.props.visible).toBe(true)
  expect(swipe.props.enterFromRight).toBe(true)
  expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('none')
  expect(within(swipe).getByRole('button', { name: '내 정보로 돌아가기' })).toBeTruthy()
  expect(within(swipe).UNSAFE_getByType(ScrollView)).toBeTruthy()
  fireEvent(swipe, 'dismiss')
  expect(screen.queryByText('로그인 수단 연결')).toBeNull()
  expect(screen.getByRole('button', { name: '로그인 및 계정 관리' })).toBeTruthy()
  expect(mockMainSignOut).not.toHaveBeenCalled()
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  expect(screen.getByTestId('account-back-swipe').props.enabled).toBe(true)
  expect(screen.getByTestId('account-back-swipe').props.visible).toBe(true)
  expect(screen.getByTestId('account-back-swipe').props.enterFromRight).toBe(true)
})

test('back swipe is blocked while starting a link and recovers after failure', async () => {
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 연결됨')
  const finishEarlierSwipe = screen.getByTestId('account-back-swipe').props.onDismiss
  let complete!: (value: unknown) => void
  mockMainRpc.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.press(screen.getByText('Google 계정 연결'))
  await waitFor(() => expect(complete).toBeDefined())
  expect(screen.getByTestId('account-back-swipe').props.enabled).toBe(false)
  act(() => finishEarlierSwipe())
  expect(screen.getByRole('button', { name: '내 정보로 돌아가기' })).toBeDisabled()
  await act(async () => complete({ error: new Error('offline') }))
  expect(screen.getByTestId('account-back-swipe').props.enabled).toBe(true)
  fireEvent(screen.getByTestId('account-back-swipe'), 'dismiss')
  expect(screen.queryByText('로그인 수단 연결')).toBeNull()
})

test('the parent account menu cannot close while a link dialog is open', async () => {
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  const finishEarlierSwipe = screen.getByTestId('account-back-swipe').props.onDismiss
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  await screen.findByText('Google 인증 후 연결')
  expect(screen.getByRole('button', { name: '내 정보로 돌아가기' })).toBeDisabled()
  expect(screen.getByTestId('account-back-swipe').props.enabled).toBe(false)
  act(() => finishEarlierSwipe())
  const parent = screen.UNSAFE_getAllByType(Modal)[0]!
  fireEvent(parent, 'requestClose')
  expect(screen.getByText('Google 인증 후 연결')).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '닫기' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '내 정보로 돌아가기' })).not.toBeDisabled())
  expect(screen.getByTestId('account-back-swipe').props.enabled).toBe(true)
  fireEvent(screen.getByTestId('account-back-swipe'), 'dismiss')
  expect(screen.queryByText('로그인 수단 연결')).toBeNull()
})

test('a pending Google link can be cancelled without changing the signed-in account', async () => {
  mockGoogle.mockImplementation((_main, _active, _consume, signal: AbortSignal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(false))
  }))
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  fireEvent.press(await screen.findByText('Google 인증 후 연결'))
  fireEvent.press(await screen.findByRole('button', { name: '인증 취소' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).not.toBeDisabled())
  expect(mockGoogle.mock.calls[0][3].aborted).toBe(true)
  expect(mockProofRpc).not.toHaveBeenCalled()
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('phone account links Google only after explicit selection and displays success', async () => {
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  const verify = await screen.findByText('Google 인증 후 연결')
  expect(mockGoogle).not.toHaveBeenCalled()
  fireEvent.press(verify)
  await screen.findByText(/연결되었습니다/)
  expect(mockProofRpc).toHaveBeenCalledWith('finish_account_link', expect.objectContaining({ link_ticket: 'c'.repeat(64) }))
  expect(mockMainRpc.mock.calls.some(call => call[0].startsWith('authorize_'))).toBe(false)
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('Google account verifies SMS in an isolated client, without signing out its Google session', async () => {
  providers = ['google']
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('전화번호 연결'))
  fireEvent.changeText(await screen.findByLabelText('Link phone number'), '01012345678')
  expect(screen.getByLabelText('Link SMS code').props.editable).toBe(false)
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitFor(() => expect(screen.getByLabelText('Link SMS code').props.editable).toBe(true))
  expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: true, channel: 'sms' } })
  fireEvent.changeText(screen.getByLabelText('Link SMS code'), '123456')
  fireEvent.press(screen.getByText('인증번호 확인 후 연결'))
  await screen.findByText(/연결되었습니다/)
  expect(mockProofRpc).toHaveBeenCalledTimes(1)
  expect(mockVerify.mock.invocationCallOrder[0]!).toBeLessThan(mockProofRpc.mock.invocationCallOrder[0]!)
  expect(mockProofSignOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('closing the dialog cancels without authenticating or changing accounts', async () => {
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  fireEvent.press(await screen.findByText('닫기'))
  await waitFor(() => expect(screen.queryByText('Google 인증 후 연결')).toBeNull())
  expect(mockGoogle).not.toHaveBeenCalled()
  expect(mockProofRpc).not.toHaveBeenCalled()
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('stale phone verification is refreshed inline without logout before linking another provider', async () => {
  let beginAttempts = 0
  mockMainRpc.mockImplementation(async (name: string, args: any) => name === 'account_login_methods'
    ? { data: { account_id: accountId, providers } }
    : ++beginAttempts === 1 ? { data: { error: 'link_reauthentication_required' } }
    : { data: { ok: true, account_id: accountId, provider: args.target_provider, ticket: 'c'.repeat(64) } })
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  await screen.findByText('현재 계정 다시 인증')
  expect(screen.getByLabelText('Current phone number').props.value).toBe('01012345678')
  fireEvent.press(screen.getByText('현재 번호로 인증번호 받기'))
  await waitFor(() => expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: false, channel: 'sms' } }))
  fireEvent.changeText(screen.getByLabelText('Current account SMS code'), '123456')
  fireEvent.press(screen.getByText('현재 계정 인증 후 계속'))
  await screen.findByText('Google 인증 후 연결')
  expect(mockProofRpc).toHaveBeenCalledWith('authorize_device_account_v2', expect.any(Object))
  expect(mockMainSetSession).toHaveBeenCalledWith({ access_token: 'proof-access', refresh_token: 'proof-refresh' })
  expect(beginAttempts).toBe(2)
  expect(mockGoogle).not.toHaveBeenCalled()
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('stale phone reauthentication canonicalizes a Supabase phone without a leading plus', async () => {
  let beginAttempts = 0
  mockMainGetSession.mockResolvedValue({ error: null, data: { session: { user: { id: 'verified-user', phone: '821012345678', app_metadata: { provider: 'phone' }, identities: [] } } } })
  mockMainRpc.mockImplementation(async (name: string, args: any) => name === 'account_login_methods'
    ? { data: { account_id: accountId, providers } }
    : ++beginAttempts === 1 ? { data: { error: 'link_reauthentication_required' } }
    : { data: { ok: true, account_id: accountId, provider: args.target_provider, ticket: 'c'.repeat(64) } })
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  expect((await screen.findByLabelText('Current phone number')).props.value).toBe('01012345678')
  fireEvent.press(screen.getByText('현재 번호로 인증번호 받기'))
  await waitFor(() => expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: false, channel: 'sms' } }))
  fireEvent.changeText(screen.getByLabelText('Current account SMS code'), '123456')
  fireEvent.press(screen.getByText('현재 계정 인증 후 계속'))
  await screen.findByText('Google 인증 후 연결')
  expect(mockVerify).toHaveBeenCalledWith({ phone: '+821012345678', token: '123456', type: 'sms' })
})

test('server conflict keeps the source account and does not report success', async () => {
  mockProofRpc.mockResolvedValue({ data: { error: 'account_link_conflict' } })
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('Google 계정 연결'))
  fireEvent.press(await screen.findByText('Google 인증 후 연결'))
  await screen.findByText(/이미 다른 계정에 등록되어/)
  expect(screen.queryByText(/연결되었습니다/)).toBeNull()
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('already linked accounts have no replace or unlink action', async () => {
  providers = ['phone', 'google', 'kakao']
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  await screen.findByText('전화번호 · Google · 카카오톡 연결됨')
  expect(screen.queryByText('Google 계정 연결')).toBeNull()
  expect(screen.queryByText('전화번호 연결')).toBeNull()
  expect(screen.queryByText('카카오 계정 연결')).toBeNull()
})

test('a phone plus Google account explicitly links Kakao as its third method', async () => {
  providers = ['phone', 'google']
  render(<AccountSessionSettings />)
  fireEvent.press(screen.getByRole('button', { name: '로그인 및 계정 관리' }))
  fireEvent.press(await screen.findByText('카카오 계정 연결'))
  fireEvent.press(await screen.findByText('카카오 인증 후 연결'))
  await screen.findByText(/연결되었습니다/)
  expect(mockKakao).toHaveBeenCalledTimes(1)
  expect(mockGoogle).not.toHaveBeenCalled()
  expect(mockMainRpc).toHaveBeenCalledWith('begin_account_link_v2', expect.objectContaining({ target_provider: 'kakao' }))
  expect(mockMainSignOut).not.toHaveBeenCalled()
})

test('a late SMS verification after unmount cannot finish a link', async () => {
  let complete!: (value: unknown) => void
  mockVerify.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const request: AccountLinkRequest = { accountId, provider: 'phone', ticket: 'c'.repeat(64), secret: 'a'.repeat(64), identity: { platform: 'android', identifier: 'b'.repeat(64) } }
  const view = render(<AccountLinkDialog client={{} as any} request={request} english={false} onClose={jest.fn()} onLinked={jest.fn()} />)
  fireEvent.changeText(screen.getByLabelText('Link phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitFor(() => expect(screen.getByLabelText('Link SMS code').props.editable).toBe(true))
  fireEvent.changeText(screen.getByLabelText('Link SMS code'), '123456')
  fireEvent.press(screen.getByText('인증번호 확인 후 연결'))
  await waitFor(() => expect(mockVerify).toHaveBeenCalled())
  view.unmount()
  await act(async () => complete({ error: null }))
  expect(mockProofRpc).not.toHaveBeenCalled()
  expect(mockProofSignOut).toHaveBeenCalled()
})

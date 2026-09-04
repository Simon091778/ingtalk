import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { Alert, AppState, Keyboard, Linking, Modal, Platform, ScrollView, Text, TextInput } from 'react-native'
import { PhoneAuthGate } from '../PhoneAuthGate'
import { AppEntryGate } from '../AppEntryGate'
import { I18nProvider } from '../../i18n'
import { useAuthorizedAccountId } from '../../lib/authorizedAccount'
import { RetainedTab } from '../RetainedTab'

let mockSession: any
let mockAuthListener: (event: string, session?: any) => void
const mockRpc = jest.fn()
const mockSend = jest.fn()
const mockVerify = jest.fn()
const mockKey = jest.fn()
const mockReinstallIdentity = jest.fn()
const mockDelete = jest.fn()
const mockReadPreferences = jest.fn()
const mockSavePreferences = jest.fn()
const mockSupportsPhoneHint = jest.fn()
const mockPhoneHint = jest.fn()
const mockExpoGoTesting = jest.fn()
const mockPrepareSmsAutofill = jest.fn()
const mockStopSmsAutofill = jest.fn()
const mockGoogleSignIn = jest.fn()
const mockKakaoSignIn = jest.fn()
const mockOpenURL = jest.fn()
const mockAlert = jest.fn()
const mockPhoneAuthDiagnostic = jest.fn()
jest.mock('../../lib/observability', () => ({ addAppBreadcrumb: jest.fn(), captureAppError: jest.fn() }))
jest.mock('../../lib/phoneAuthDiagnostics', () => ({ logPhoneAuthDiagnostic: (...args: unknown[]) => mockPhoneAuthDiagnostic(...args) }))
jest.mock('../../lib/kakaoAuth', () => ({ signInWithKakao: (...args: unknown[]) => mockKakaoSignIn(...args) }))
jest.mock('../../lib/googleAuth', () => ({
  ...jest.requireActual('../../lib/googleAuth'),
  signInWithGoogle: (...args: unknown[]) => mockGoogleSignIn(...args),
}))
jest.mock('../../lib/smsCodeAutofill', () => ({ prepareSmsCodeAutofill: (...args: unknown[]) => mockPrepareSmsAutofill(...args) }))
jest.mock('../../lib/expoGoAuth', () => ({ isExpoGoAuthTesting: () => mockExpoGoTesting() }))
const originalPlatform = Platform.OS
jest.mock('../../lib/phoneNumberHint', () => ({
  supportsPhoneNumberHint: () => mockSupportsPhoneHint(),
  requestPhoneNumberHint: () => mockPhoneHint(),
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: unknown[]) => mockReadPreferences(...args),
  setItemAsync: (...args: unknown[]) => mockSavePreferences(...args),
}))
jest.mock('../SwipeDismissView', () => ({ SwipeDismissView: ({ children, edgeWidth, ...props }: any) => edgeWidth === undefined ? children :
  require('react').createElement(require('react-native').View, { testID: 'auth-back-swipe', edgeWidth, ...props }, children) }))
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View, SafeAreaProvider: jest.requireActual('react-native').View }))
jest.mock('../../lib/deviceAccountKey', () => ({ getDeviceAccountKey: () => mockKey() }))
jest.mock('../../lib/deviceReinstallIdentity', () => ({ getDeviceReinstallIdentity: (...args: unknown[]) => mockReinstallIdentity(...args) }))
jest.mock('../../lib/supabase', () => ({ supabase: {
  rpc: (...args: unknown[]) => mockRpc(...args),
  functions: { invoke: (...args: unknown[]) => mockDelete(...args) },
  auth: {
    getSession: async () => ({ data: { session: mockSession } }),
    onAuthStateChange: (callback: (event: string, session?: any) => void) => { mockAuthListener = callback; return { data: { subscription: { unsubscribe: jest.fn() } } } },
    signInWithOtp: (...args: unknown[]) => mockSend(...args),
    verifyOtp: (...args: unknown[]) => mockVerify(...args),
    signOut: async () => { mockSession = null; mockAuthListener('SIGNED_OUT'); return { error: null } },
  },
} }))
beforeEach(() => {
  mockOpenURL.mockReset().mockResolvedValue(undefined)
  mockAlert.mockReset()
  mockPhoneAuthDiagnostic.mockReset()
  jest.spyOn(Linking, 'openURL').mockImplementation(mockOpenURL)
  jest.spyOn(Alert, 'alert').mockImplementation(mockAlert)
  mockSession = null
  mockRpc.mockReset(); mockSend.mockReset(); mockVerify.mockReset(); mockKey.mockReset()
  mockDelete.mockReset()
  mockSupportsPhoneHint.mockReset().mockReturnValue(false)
  mockPhoneHint.mockReset().mockResolvedValue(null)
  mockExpoGoTesting.mockReset().mockReturnValue(false)
  mockStopSmsAutofill.mockReset()
  mockGoogleSignIn.mockReset().mockResolvedValue(false)
  mockKakaoSignIn.mockReset().mockResolvedValue(false)
  mockPrepareSmsAutofill.mockReset().mockResolvedValue(mockStopSmsAutofill)
  mockReadPreferences.mockReset().mockResolvedValue(null)
  mockSavePreferences.mockReset().mockResolvedValue(undefined)
  mockReinstallIdentity.mockReset()
  mockReinstallIdentity.mockResolvedValue({ platform: 'android', identifier: 'b'.repeat(64) })
  mockKey.mockResolvedValue('a'.repeat(64))
  mockRpc.mockResolvedValue({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } })
  mockSend.mockResolvedValue({ error: null })
  mockVerify.mockImplementation(async () => {
    mockSession = { user: { id: 'AuthID', is_anonymous: false } }
    return { data: { session: mockSession, user: mockSession.user }, error: null }
  })
})
afterEach(() => { jest.restoreAllMocks(); Object.assign(Platform, { OS: originalPlatform }) })
const waitForSmsInput = () => waitFor(() => {
  const input = screen.getByLabelText('SMS code')
  expect(input.props.editable).toBe(true)
  return input
})
const mount = () => render(<PhoneAuthGate language="ko"><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>)

test('signout disposes hidden retained screen state inside the real authentication gate', async () => {
  const disposed = jest.fn()
  function PrivateScreen() {
    require('react').useEffect(() => disposed, [])
    return <Text>RETAINED PRIVATE SCREEN</Text>
  }
  const tree = (active: boolean) => <PhoneAuthGate language="ko"><RetainedTab active={active}><PrivateScreen /></RetainedTab></PhoneAuthGate>
  mockSession = { user: { id: 'AuthID' } }
  const view = render(tree(true))
  await screen.findByText('RETAINED PRIVATE SCREEN')
  view.rerender(tree(false))
  expect(disposed).not.toHaveBeenCalled()
  act(() => { mockSession = null; mockAuthListener('SIGNED_OUT') })
  await waitFor(() => expect(disposed).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('RETAINED PRIVATE SCREEN', { includeHiddenElements: true })).toBeNull()
})

test.each(['ko', 'en'] as const)('international review-style number uses normal server OTP and device authorization (%s)', async language => {
  // Fictional fixture only: never put live review credentials in the app/test bundle.
  render(<PhoneAuthGate language={language}><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>)
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '+1 (202) 555-0198')
  fireEvent.press(screen.getByRole('button', { name: language === 'ko' ? '인증번호 받기' : 'Send SMS code' }))
  fireEvent.changeText(await waitForSmsInput(), '246813')
  expect(mockSend).toHaveBeenCalledWith({ phone: '+12025550198', options: { shouldCreateUser: true, channel: 'sms' } })
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  mockVerify.mockResolvedValueOnce({ error: new Error('Invalid OTP') })
  fireEvent.press(screen.getByRole('button', { name: language === 'ko' ? '인증번호 확인' : 'Verify code' }))
  await waitFor(() => expect(mockVerify).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('button', { name: language === 'ko' ? '인증번호 확인' : 'Verify code' })).not.toBeDisabled())
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockRpc).not.toHaveBeenCalled()
  fireEvent.press(screen.getByRole('button', { name: language === 'ko' ? '인증번호 확인' : 'Verify code' }))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockVerify).toHaveBeenLastCalledWith({ phone: '+12025550198', token: '246813', type: 'sms' })
  expect(mockRpc).toHaveBeenCalledWith('authorize_device_account_v2', {
    device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64),
  })
})

test('interrupted Kakao auth shows an explanation and allows retry without entering the account', async () => {
  mockKakaoSignIn.mockRejectedValueOnce(new Error('kakao_auth_interrupted'))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: '카카오톡' }))
  fireEvent.press(screen.getByRole('button', { name: '카카오로 계속하기' }))
  await screen.findByText('카카오 인증이 완료되기 전에 로그인 창이 닫혔어요. 다시 시도해 주세요.')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '카카오로 계속하기' }))
  await waitFor(() => expect(mockKakaoSignIn).toHaveBeenCalledTimes(2))
})

test('Kakao button starts only Kakao and cancellation preserves the SMS form', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByRole('tab', { name: '카카오톡' }))
  fireEvent.press(screen.getByRole('button', { name: '카카오로 계속하기' }))
  await waitFor(() => expect(mockKakaoSignIn).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('tab', { name: '전화번호' }).props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByRole('tab', { name: '전화번호' }))
  expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
  expect(mockGoogleSignIn).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})

test('occupied device does not mount private data and lets the user select the existing login', async () => {
  mockSession = { user: { id: 'NewPhoneID', is_anonymous: false } }
  mockRpc.mockResolvedValue({ data: { error: 'account_link_required' } })
  mount()
  const back = await screen.findByText('기존 로그인 방식으로 돌아가기')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(screen.getByText(/고객지원 문의/)).toBeTruthy()
  fireEvent.press(back)
  await screen.findByLabelText('Phone number')
  expect(mockSession).toBeNull()
})

test('Google occupied-device rejection preserves the gate and displays the linking guidance', async () => {
  mockGoogleSignIn.mockRejectedValue(new Error('account_link_required'))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByText('Google로 계속하기'))
  await screen.findByText('기존 로그인 방식으로 돌아가기')
  expect(screen.getByTestId('account-link-required-guide')).toBeTruthy()
  expect(screen.getByText(/전화번호 인증이 필수라는 뜻은 아닙니다/)).toBeTruthy()
  expect(screen.getByText(/내 정보 → 로그인 및 계정 관리 → 로그인 수단 연결/)).toBeTruthy()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockOpenURL).not.toHaveBeenCalled()
  expect(mockAlert).not.toHaveBeenCalled()
})

test('support email requires a separate confirmation and cancellation preserves account guidance', async () => {
  mockGoogleSignIn.mockRejectedValue(new Error('account_link_required'))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByText('Google로 계속하기'))
  fireEvent.press(await screen.findByRole('button', { name: '이메일로 고객지원 문의' }))
  const [title, message, actions] = mockAlert.mock.calls[0]
  expect(title).toBe('이메일로 고객지원 문의')
  expect(message).toContain('로그인이 아닌 이메일 문의 기능입니다')
  expect(actions[0]).toEqual({ text: '취소', style: 'cancel' })
  expect(mockOpenURL).not.toHaveBeenCalled()
  expect(screen.getByTestId('account-link-required-guide')).toBeTruthy()
  await act(async () => { await actions[1].onPress() })
  expect(mockOpenURL).toHaveBeenCalledTimes(1)
  expect(mockOpenURL).toHaveBeenCalledWith('mailto:itembus@itembus.com?subject=Ingtalk%20sign-in%20help')
  expect(screen.getByTestId('account-link-required-guide')).toBeTruthy()
  expect(mockGoogleSignIn).toHaveBeenCalledTimes(1)
})

test('failed support email launch shows its address without changing the authentication error', async () => {
  mockGoogleSignIn.mockRejectedValue(new Error('account_link_required'))
  mockOpenURL.mockRejectedValue(new Error('no mail app'))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByText('Google로 계속하기'))
  fireEvent.press(await screen.findByRole('button', { name: '이메일로 고객지원 문의' }))
  await act(async () => { await mockAlert.mock.calls[0][2][1].onPress() })
  expect(mockAlert).toHaveBeenLastCalledWith('메일 앱을 열 수 없어요', expect.stringContaining('itembus@itembus.com'))
  expect(screen.getByTestId('account-link-required-guide')).toBeTruthy()
  expect(screen.queryByText('no mail app')).toBeNull()
})

test('retrying Google removes stale support actions while authentication is pending', async () => {
  let finish!: (result: boolean) => void
  mockGoogleSignIn.mockRejectedValueOnce(new Error('account_link_required'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByText('Google로 계속하기'))
  await screen.findByRole('button', { name: '이메일로 고객지원 문의' })
  fireEvent.press(screen.getByText('Google로 계속하기'))
  await waitFor(() => expect(mockGoogleSignIn).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: '이메일로 고객지원 문의' })).toBeNull()
  expect(screen.queryByTestId('account-link-required-guide')).toBeNull()
  await act(async () => { finish(false) })
  expect(mockOpenURL).not.toHaveBeenCalled()
})

test('switching login method clears stale linking and email guidance', async () => {
  mockGoogleSignIn.mockRejectedValue(new Error('account_link_required'))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByText('Google로 계속하기'))
  await screen.findByRole('button', { name: '이메일로 고객지원 문의' })
  fireEvent.press(screen.getByRole('tab', { name: '카카오톡' }))
  expect(screen.queryByRole('button', { name: '이메일로 고객지원 문의' })).toBeNull()
  expect(screen.queryByText('기존 로그인 방식으로 돌아가기')).toBeNull()
  fireEvent.press(screen.getByText('카카오로 계속하기'))
  await waitFor(() => expect(mockKakaoSignIn).toHaveBeenCalledTimes(1))
  expect(mockOpenURL).not.toHaveBeenCalled()
})

test.each([
  ['ko', '전화번호는 다른 이용자에게 공개되지 않습니다.'],
  ['en', 'Your number is not shown to other users.'],
] as const)('keeps the %s introduction to a single privacy line', async (language, summary) => {
  render(<PhoneAuthGate language={language}><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>)
  await screen.findByLabelText('Phone number')
  const text = screen.getByText(summary)
  expect(text.props.numberOfLines).toBe(1)
  expect(text.props.adjustsFontSizeToFit).toBe(true)
  expect(screen.queryByText(/문자 인증만 하면 시작|Verify by SMS to get started/)).toBeNull()
})

test('provider tabs show previews without authenticating and preserve the phone form', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  expect(screen.queryByText('전화번호로 간편하게 시작')).toBeNull()
  expect(screen.getByText('잉톡 인증')).toBeTruthy()
  for (const name of ['Google 계정', '카카오톡']) {
    fireEvent.press(screen.getByRole('tab', { name }))
    expect(screen.getByRole('tab', { name }).props.accessibilityState.selected).toBe(true)
    expect(screen.queryByLabelText('Phone number')).toBeNull()
    if (name === '카카오톡') expect(screen.getByRole('button', { name: '카카오로 계속하기' })).toBeTruthy()
    else expect(screen.getByRole('button', { name: 'Google로 계속하기' })).toBeTruthy()
  }
  expect(mockSend).not.toHaveBeenCalled()
  expect(mockVerify).not.toHaveBeenCalled()
  expect(mockRpc).not.toHaveBeenCalled()
  fireEvent.press(screen.getByRole('tab', { name: '전화번호' }))
  expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
  expect(screen.getByLabelText('SMS code')).toBeTruthy()
})

test.each(['android', 'ios'] as const)('does not force verification scrolling on focus or resize (%s)', async platform => {
  Object.assign(Platform, { OS: platform })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  const scroll = screen.UNSAFE_getAllByType(ScrollView)[0]!.instance
  const input = screen.UNSAFE_getAllByType(TextInput).find(node => node.props.accessibilityLabel === 'SMS code')!.instance
  const scrollTo = jest.spyOn(scroll, 'scrollTo').mockImplementation(() => {})
  const isFocused = jest.spyOn(input, 'isFocused').mockReturnValue(true)
  try {
    fireEvent(screen.getByTestId('phone-auth-form'), 'layout', { nativeEvent: { layout: { y: 160 } } })
    fireEvent(screen.getByTestId('phone-verification-controls'), 'layout', { nativeEvent: { layout: { y: 140 } } })
    scrollTo.mockClear()
    fireEvent(screen.getByLabelText('SMS code'), 'focus')
    fireEvent(screen.getByTestId('auth-scroll'), 'layout', { nativeEvent: { layout: { height: 260 } } })
    expect(scrollTo).not.toHaveBeenCalled()
    expect(within(screen.getByTestId('phone-verification-controls')).getByText('인증번호 확인')).toBeTruthy()
    isFocused.mockReturnValue(false)
    scrollTo.mockClear()
    fireEvent(screen.getByTestId('auth-scroll'), 'layout', { nativeEvent: { layout: { height: 600 } } })
    expect(scrollTo).not.toHaveBeenCalled()
  } finally { scrollTo.mockRestore(); isFocused.mockRestore() }
})

test('restored Auth session must authorize using the saved device key', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockRpc).toHaveBeenCalledWith('authorize_device_account_v2', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) })
  expect(screen.queryByLabelText('Account password')).toBeNull()
  expect(screen.queryByLabelText('Recovery code')).toBeNull()
})

test('restoring a session shows only startup branding until the server approves it', async () => {
  mockSession = { access_token: 'restored-token', user: { id: 'AuthID' } }
  let finish!: (result: any) => void
  mockRpc.mockReturnValue(new Promise(resolve => { finish = resolve }))
  mount()
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('app-startup-screen')).toBeTruthy()
  expect(screen.queryByText('잉톡 인증')).toBeNull()
  expect(screen.queryByRole('tab', { name: 'Google 계정' })).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  await act(async () => finish({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } }))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(screen.queryByText('잉톡 인증')).toBeNull()
})

test('repeated SIGNED_IN for the identical session neither remounts the app nor reauthorizes it', async () => {
  mockSession = { access_token: 'same-token', user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  await act(async () => {
    mockAuthListener('SIGNED_IN', { ...mockSession })
    mockAuthListener('SIGNED_IN', { ...mockSession })
  })
  expect(mockRpc).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('app-startup-screen')).toBeNull()
  expect(screen.getByText('PRIVATE ACCOUNT DATA')).toBeTruthy()
})

test('concurrent foreground checks share one pending request without flashing authentication', async () => {
  mockSession = { access_token: 'same-token', user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  let finish!: (result: any) => void
  mockRpc.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const onChange = jest.mocked(AppState.addEventListener).mock.calls.find(([event]) => event === 'change')?.[1]
  act(() => { onChange?.('active'); onChange?.('active'); onChange?.('active') })
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2))
  expect(screen.getByText('PRIVATE ACCOUNT DATA')).toBeTruthy()
  expect(screen.queryByText('잉톡 인증')).toBeNull()
  await act(async () => finish({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } }))
  expect(mockRpc).toHaveBeenCalledTimes(2)
})

test('changed tokens are rechecked and revoked access removes the authenticated app', async () => {
  mockSession = { access_token: 'old-token', user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  mockSession = { ...mockSession, access_token: 'new-token' }
  mockRpc.mockResolvedValue({ data: { error: 'device_binding_mismatch' } })
  act(() => mockAuthListener('TOKEN_REFRESHED', mockSession))
  await screen.findByText('다시 확인')
  expect(mockRpc).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})

test('late approval for a previous session cannot overwrite the new account context', async () => {
  function Principal() { return <Text>{useAuthorizedAccountId()}</Text> }
  mockSession = { access_token: 'old-token', user: { id: 'OldAuthID' } }
  let finishOld!: (result: any) => void
  mockRpc.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValue({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000002', created: false, restored: false } })
  render(<PhoneAuthGate language="ko"><Principal /></PhoneAuthGate>)
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1))
  mockSession = { access_token: 'new-token', user: { id: 'NewAuthID' } }
  act(() => mockAuthListener('SIGNED_IN', mockSession))
  await screen.findByText('10000000-0000-4000-8000-000000000002')
  await act(async () => finishOld({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } }))
  expect(screen.queryByText('10000000-0000-4000-8000-000000000001')).toBeNull()
  expect(screen.getByText('10000000-0000-4000-8000-000000000002')).toBeTruthy()
})

test('signout invalidates an in-flight startup approval', async () => {
  mockSession = { user: { id: 'AuthID' } }
  let finish!: (result: any) => void
  mockRpc.mockReturnValue(new Promise(resolve => { finish = resolve }))
  mount()
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1))
  act(() => { mockSession = null; mockAuthListener('SIGNED_OUT', null) })
  await act(async () => finish({ data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: false, restored: false } }))
  await screen.findByLabelText('Phone number')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})

test('restored Google session uses its own server authorization before mounting private data', async () => {
  mockSession = { user: { id: 'GoogleID', app_metadata: { provider: 'google' } } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockRpc).toHaveBeenCalledWith('authorize_google_device_account', { device_secret: 'a'.repeat(64), device_platform: 'android', reinstall_identifier: 'b'.repeat(64) })
})

test('cancelled Google sign-in preserves a pending phone code and resend cooldown', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByRole('button', { name: 'Google로 계속하기' }))
  await waitFor(() => expect(mockGoogleSignIn).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('tab', { name: '전화번호' })).not.toBeDisabled())
  fireEvent.press(screen.getByRole('tab', { name: '전화번호' }))
  expect(screen.getByLabelText('SMS code').props.value).toBe('123456')
  expect(screen.getByRole('button', { name: '인증번호 받기' })).toBeDisabled()
  expect(mockVerify).not.toHaveBeenCalled()
})

test.each(['google', 'kakao'])('pending %s auth can be explicitly cancelled while preserving phone input', async provider => {
  const signIn = provider === 'google' ? mockGoogleSignIn : mockKakaoSignIn
  signIn.mockImplementation((_client, _active, _consume, signal: AbortSignal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(false))
  }))
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByRole('tab', { name: provider === 'google' ? 'Google 계정' : '카카오톡' }))
  fireEvent.press(screen.getByRole('button', { name: provider === 'google' ? 'Google로 계속하기' : '카카오로 계속하기' }))
  fireEvent.press(await screen.findByRole('button', { name: '인증 취소' }))
  await waitFor(() => expect(screen.getByRole('tab', { name: '전화번호' })).not.toBeDisabled())
  expect(signIn.mock.calls[0][3].aborted).toBe(true)
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '전화번호' }))
  expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
})

test('unmounting the auth gate cancels the pending browser attempt', async () => {
  mockGoogleSignIn.mockImplementation((_client, _active, _consume, signal: AbortSignal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(false))
  }))
  const view = mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByRole('button', { name: 'Google로 계속하기' }))
  await screen.findByRole('button', { name: '인증 취소' })
  await act(async () => view.unmount())
  expect(mockGoogleSignIn.mock.calls[0][3].aborted).toBe(true)
})

test('successful Google sign-in enters the app without opening email support', async () => {
  mockGoogleSignIn.mockImplementation(async () => {
    mockSession = { user: { id: 'GoogleID', app_metadata: { provider: 'google' } } }
    return true
  })
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByRole('button', { name: 'Google로 계속하기' }))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockOpenURL).not.toHaveBeenCalled()
  expect(mockAlert).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
})

test('Google sign-in locks provider navigation and requires server approval', async () => {
  let finish!: (value: boolean) => void
  mockGoogleSignIn.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  mount()
  await screen.findByLabelText('Phone number')
  fireEvent.press(screen.getByRole('tab', { name: 'Google 계정' }))
  fireEvent.press(screen.getByRole('button', { name: 'Google로 계속하기' }))
  expect(screen.getByRole('tab', { name: '전화번호' })).toBeDisabled()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  mockSession = { user: { id: 'GoogleID', app_metadata: { provider: 'google' } } }
  mockRpc.mockResolvedValue({ data: { error: 'device_binding_mismatch' } })
  await act(async () => finish(true))
  await screen.findByText('다시 확인')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockSend).not.toHaveBeenCalled()
})
test('unknown or offline authorization state fails closed', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mockRpc.mockResolvedValue({ error: new Error('network down') })
  mount()
  await screen.findByText('다시 확인')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})
test('SMS signup goes straight to the authorized app without extra input', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '010-1234-5678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  expect(mockKey).toHaveBeenCalled()
  expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: true, channel: 'sms' } })
  fireEvent.changeText(screen.getByLabelText('SMS code'), '123456')
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(screen.queryByLabelText('Account password')).toBeNull()
})

test('invalid OTP stays in the Auth stage and never starts account resolution', async () => {
  mockVerify.mockResolvedValueOnce({ data: { session: null, user: null }, error: new Error('Token has expired or is invalid') })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByText('인증번호가 올바르지 않거나 만료되었습니다. 새 인증번호를 요청한 뒤 다시 시도해 주세요.')
  expect(mockRpc).not.toHaveBeenCalledWith('authorize_device_account_v2', expect.anything())
  expect(mockPhoneAuthDiagnostic).toHaveBeenCalledWith('PHONE_AUTH_VERIFY_FAILURE', {
    platform: Platform.OS, errorCode: 'otp_verification_failed',
  })
})

test('successful OTP with account RPC failure reports account preparation instead of invalid OTP', async () => {
  mockRpc.mockResolvedValueOnce({ error: new Error('constraint failure') })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByText('전화번호 인증은 완료됐지만 계정 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  expect(mockPhoneAuthDiagnostic).toHaveBeenCalledWith('PHONE_AUTH_VERIFY_SUCCESS', { platform: Platform.OS })
  expect(mockPhoneAuthDiagnostic).toHaveBeenCalledWith('PHONE_AUTH_ACCOUNT_RESOLVE_FAILURE', {
    platform: Platform.OS, errorCode: 'account_service_unavailable',
  })
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})
test('storage failure blocks sending a billable SMS', async () => {
  mockKey.mockRejectedValue(new Error('device_storage_unavailable'))
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await screen.findByRole('alert')
  expect(mockSend).not.toHaveBeenCalled()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})
test('a restored session for another key returns to SMS instead of switching principal', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mockRpc.mockImplementation(async name => name === 'authorize_device_account_v2' ? { data: { error: 'reauthenticate_required' } } : {})
  mount()
  await screen.findByLabelText('Phone number')
  expect(mockRpc).toHaveBeenCalledWith('lock_account_session')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})
test('signout immediately unmounts previous account data', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  act(() => { mockSession = null; mockAuthListener('SIGNED_OUT') })
  await waitFor(() => expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull())
})
test('interrupted last-account deletion can finish without exposing account data', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mockRpc.mockResolvedValue({ data: { error: 'account_deletion_pending' } })
  mockDelete.mockResolvedValue({ data: { deleted: true } })
  mount()
  fireEvent.press(await screen.findByText('요청한 계정 삭제 마무리'))
  await screen.findByLabelText('Phone number')
  expect(mockDelete).toHaveBeenCalledWith('delete-account', { body: { confirmation: true } })
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
})
test('binding or reinstall recovery with stale OTP returns to SMS without a password prompt', async () => {
  mockSession = { user: { id: 'AuthID' } }
  mockRpc.mockImplementation(async name => name === 'authorize_device_account_v2' ? { data: { error: 'fresh_phone_verification_required' } } : {})
  mount()
  await screen.findByLabelText('Phone number')
  expect(mockRpc).toHaveBeenCalledWith('lock_account_session')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(screen.queryByLabelText('Account password')).toBeNull()
})
test('missing native reinstall identity blocks SMS instead of creating an unrecoverable account', async () => {
  mockReinstallIdentity.mockRejectedValue(new Error('device_identity_unavailable'))
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await screen.findByRole('alert')
  expect(mockSend).not.toHaveBeenCalled()
})

const mountEntry = () => render(<I18nProvider><AppEntryGate><Text>PRIVATE ACCOUNT DATA</Text></AppEntryGate></I18nProvider>)

test('first launch saves language and country before showing localized SMS verification', async () => {
  mockRpc.mockImplementation(async name => name === 'current_account_id'
    ? { data: null }
    : { data: { ok: true, account_id: '10000000-0000-4000-8000-000000000001', created: true, restored: false } })
  let finishSave!: () => void
  mockSavePreferences.mockReturnValue(new Promise<void>(resolve => { finishSave = resolve }))
  mountEntry()
  await screen.findByText('언어와 국가를 선택해 주세요')
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(mockKey).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('English'))
  fireEvent.press(screen.getByText('United States'))
  fireEvent.press(screen.getByText('Save and continue'))
  expect(mockSavePreferences).toHaveBeenCalledWith('ingtalk.regional-preferences.v1', JSON.stringify({ language: 'en', country: 'US' }))
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  await act(async () => finishSave())
  expect(localStorage.getItem('ingtalk.region-before-phone.v1')).toBe('1')
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '+12025550123')
  expect(screen.queryByText('Choose your language and country')).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  fireEvent.press(screen.getByText('Send SMS code'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByText('Verify code'))
  await screen.findByText('PRIVATE ACCOUNT DATA')
})

test('relaunches reuse completed regional choices and go straight to localized authentication', async () => {
  localStorage.setItem('ingtalk.installation-ready.v1', '1')
  localStorage.setItem('ingtalk.region-before-phone.v1', '1')
  mockReadPreferences.mockResolvedValue(JSON.stringify({ language: 'en', country: 'US' }))
  const firstLaunch = mountEntry()
  await screen.findByText('Send SMS code')
  expect(screen.queryByText('Choose your language and country')).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  firstLaunch.unmount()
  mountEntry()
  await screen.findByText('Send SMS code')
  expect(screen.queryByText('Choose your language and country')).toBeNull()
  expect(mockSavePreferences).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
})

test('relaunch with completed regional settings restores the authorized account without regional confirmation', async () => {
  localStorage.setItem('ingtalk.installation-ready.v1', '1')
  localStorage.setItem('ingtalk.region-before-phone.v1', '1')
  mockReadPreferences.mockResolvedValue(JSON.stringify({ language: 'ko', country: 'KR' }))
  mockSession = { user: { id: 'AuthID' } }
  mountEntry()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  expect(mockKey).toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
})

test('legacy saved choices still show the regional page before phone authentication', async () => {
  localStorage.setItem('ingtalk.installation-ready.v1', '1')
  mockReadPreferences.mockResolvedValue(JSON.stringify({ language: 'en', country: 'US' }))
  mountEntry()
  await screen.findByText('Choose your language and country')
  expect(screen.getByRole('radio', { name: 'English' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByRole('radio', { name: 'United States' }).props.accessibilityState.checked).toBe(true)
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(mockKey).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('Save and continue'))
  await screen.findByLabelText('Phone number')
  expect(localStorage.getItem('ingtalk.region-before-phone.v1')).toBe('1')
})

test('surviving Keychain preferences on a fresh install do not skip regional confirmation', async () => {
  mockReadPreferences.mockResolvedValue(JSON.stringify({ language: 'en', country: 'US' }))
  mockRpc.mockResolvedValue({ data: null })
  mountEntry()
  await screen.findByText('Choose your language and country')
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(mockKey).not.toHaveBeenCalled()
})

test('deleting installation data after a completed launch requires regional setup again even with surviving preferences and session', async () => {
  localStorage.setItem('ingtalk.installation-ready.v1', '1')
  localStorage.setItem('ingtalk.region-before-phone.v1', '1')
  mockReadPreferences.mockResolvedValue(JSON.stringify({ language: 'en', country: 'US' }))
  const previousInstall = mountEntry()
  await screen.findByText('Send SMS code')
  previousInstall.unmount()
  localStorage.clear()
  mockSession = { user: { id: 'AuthID' } }
  mockRpc.mockResolvedValue({ data: null })
  mountEntry()
  await screen.findByText('Choose your language and country')
  expect(screen.getByRole('radio', { name: 'English' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByRole('radio', { name: 'United States' }).props.accessibilityState.checked).toBe(true)
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockKey).not.toHaveBeenCalled()
})

test('closing setup without saving does not mark the installation as completed', async () => {
  mockRpc.mockResolvedValue({ data: null })
  const firstLaunch = mountEntry()
  await screen.findByText('언어와 국가를 선택해 주세요')
  fireEvent.press(screen.getByText('English'))
  firstLaunch.unmount()
  mountEntry()
  await screen.findByText('언어와 국가를 선택해 주세요')
  expect(localStorage.getItem('ingtalk.region-before-phone.v1')).toBeNull()
  expect(screen.queryByLabelText('Phone number')).toBeNull()
})

test('neither SMS nor private content mounts while regional settings are loading', async () => {
  let finishRead!: (value: null) => void
  mockReadPreferences.mockReturnValue(new Promise(resolve => { finishRead = resolve }))
  mountEntry()
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  await act(async () => finishRead(null))
  await screen.findByText('언어와 국가를 선택해 주세요')
  expect(screen.queryByLabelText('Phone number')).toBeNull()
})

test('Android picker prefills the chosen number but does not send SMS or authenticate automatically', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  mockPhoneHint.mockResolvedValue('+821012345678')
  mount()
  await screen.findByDisplayValue('01012345678')
  expect(mockPhoneHint).toHaveBeenCalledTimes(1)
  expect(mockSend).not.toHaveBeenCalled()
  expect(mockVerify).not.toHaveBeenCalled()
  expect(mockKey).not.toHaveBeenCalled()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: true, channel: 'sms' } })
})

test('cancelled picker allows manual SMS entry without an extra picker button or help row', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  mount()
  await screen.findByLabelText('Phone number')
  expect(mockPhoneHint).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('이 휴대폰의 번호 선택')).toBeNull()
  expect(screen.queryByText('휴대폰 번호 확인 중…')).toBeNull()
  expect(screen.queryByText('번호를 직접 입력해 주세요. 문자 인증은 동일하게 진행됩니다.')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('Phone number'), '01012345678')
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  expect(mockPhoneHint).toHaveBeenCalledTimes(1)
  expect(mockSend).toHaveBeenCalledWith({ phone: '+821012345678', options: { shouldCreateUser: true, channel: 'sms' } })
})

test('a delayed hint cannot overwrite a number the user has typed', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  let resolveHint!: (number: string) => void
  mockPhoneHint.mockReturnValue(new Promise<string>(resolve => { resolveHint = resolve }))
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01099998888')
  expect(screen.queryByText('휴대폰 번호 확인 중…')).toBeNull()
  expect(screen.queryByText('이 휴대폰의 번호 선택')).toBeNull()
  await act(async () => resolveHint('+821012345678'))
  expect(screen.getByLabelText('Phone number').props.value).toBe('01099998888')
  expect(mockSend).not.toHaveBeenCalled()
})

test('a delayed hint cannot affect another authentication generation', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  let resolveHint!: (number: string) => void
  mockPhoneHint.mockReturnValue(new Promise<string>(resolve => { resolveHint = resolve }))
  mount()
  await screen.findByLabelText('Phone number')
  act(() => mockAuthListener('SIGNED_OUT'))
  await act(async () => resolveHint('+821012345678'))
  expect(screen.getByLabelText('Phone number').props.value).toBe('')
  expect(mockPhoneHint).toHaveBeenCalledTimes(1)
})

test('regional selection and restored authorized sessions do not open the picker', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  const entry = mountEntry()
  await screen.findByText('언어와 국가를 선택해 주세요')
  expect(mockPhoneHint).not.toHaveBeenCalled()
  entry.unmount()
  mockSession = { user: { id: 'AuthID' } }
  mount()
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockPhoneHint).not.toHaveBeenCalled()
})

test('iOS exposes telephone and SMS code autofill semantics without a native number picker', async () => {
  Object.assign(Platform, { OS: 'ios' })
  mount()
  const phoneInput = await screen.findByLabelText('Phone number')
  expect(phoneInput.props.textContentType).toBe('telephoneNumber')
  expect(screen.queryByText('이 휴대폰의 번호 선택')).toBeNull()
  expect(mockPhoneHint).not.toHaveBeenCalled()
  fireEvent.changeText(phoneInput, '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  expect((await waitForSmsInput()).props.autoComplete).toBe('one-time-code')
})

async function enterPhoneStep() {
  mountEntry()
  fireEvent.press(await screen.findByText('저장하고 계속하기'))
  await screen.findByLabelText('Phone number')
}

test('returning from the SMS app keeps the pending OTP instead of restarting regional selection', async () => {
  const subscription = jest.mocked(AppState.addEventListener)
  await enterPhoneStep()
  fireEvent.changeText(screen.getByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  const onChange = subscription.mock.calls.find(([event]) => event === 'change')?.[1]
  expect(onChange).toBeDefined()
  act(() => { onChange?.('background'); onChange?.('active') })
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  expect(screen.getByLabelText('SMS code').props.value).toBe('123456')
  expect(screen.getByRole('button', { name: /^(인증번호 받기|Send SMS code)$/ })).toBeDisabled()
  expect(mockSend).toHaveBeenCalledTimes(1)
})

test('back button edits regional choices and returns with the entered number and picker state intact', async () => {
  mockSupportsPhoneHint.mockReturnValue(true)
  mockPhoneHint.mockResolvedValue('+821012345678')
  await enterPhoneStep()
  await screen.findByDisplayValue('01012345678')
  fireEvent.press(screen.getByRole('button', { name: '언어·국가 선택으로 돌아가기' }))
  await screen.findByText('언어와 국가를 선택해 주세요')
  expect(screen.queryByLabelText('Phone number')).toBeNull()
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  fireEvent.press(screen.getByText('English'))
  fireEvent.press(screen.getByText('United States'))
  fireEvent.press(screen.getByText('Save and continue'))
  await screen.findByRole('button', { name: 'Back to language and country' })
  expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
  expect(mockSavePreferences).toHaveBeenLastCalledWith('ingtalk.regional-preferences.v1', JSON.stringify({ language: 'en', country: 'US' }))
  expect(mockPhoneHint).toHaveBeenCalledTimes(1)
  expect(mockSend).not.toHaveBeenCalled()
})

test.each(['button', 'swipe'])('regional %s round trip preserves the current OTP and does not reset the resend cooldown', async method => {
  await enterPhoneStep()
  fireEvent.changeText(screen.getByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  if (method === 'swipe') {
    expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(true)
    fireEvent(screen.getByTestId('auth-back-swipe'), 'dismiss')
  } else fireEvent.press(screen.getByRole('button', { name: '언어·국가 선택으로 돌아가기' }))
  fireEvent.press(await screen.findByText('English'))
  fireEvent.press(screen.getByText('Save and continue'))
  expect((await waitForSmsInput()).props.value).toBe('123456')
  expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
  const resend = screen.getByRole('button', { name: /^(인증번호 받기|Send SMS code)$/ })
  expect(resend).toBeDisabled()
  fireEvent.press(resend)
  expect(mockSend).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByText('Verify code'))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockVerify).toHaveBeenCalledWith({ phone: '+821012345678', token: '123456', type: 'sms' })
})

test('back navigation is disabled while sending a verification message', async () => {
  let finishSend!: (value: { error: null }) => void
  mockSend.mockReturnValue(new Promise(resolve => { finishSend = resolve }))
  await enterPhoneStep()
  fireEvent.changeText(screen.getByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
  const back = screen.getByRole('button', { name: '언어·국가 선택으로 돌아가기' })
  expect(back).toBeDisabled()
  fireEvent.press(back)
  expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(false)
  fireEvent(screen.getByTestId('auth-back-swipe'), 'dismiss')
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  await act(async () => finishSend({ error: null }))
  await waitForSmsInput()
  expect(screen.getByRole('button', { name: '언어·국가 선택으로 돌아가기' })).not.toBeDisabled()
})

test('privacy modal and missing previous page disable the auth back swipe', async () => {
  const view = mount()
  await screen.findByLabelText('Phone number')
  expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(false)
  view.unmount()
  await enterPhoneStep()
  const finishEarlierSwipe = screen.getByTestId('auth-back-swipe').props.onDismiss
  fireEvent.press(screen.getByText('개인정보 처리 안내 보기'))
  const swipe = screen.getByTestId('auth-back-swipe')
  expect(swipe.props.enabled).toBe(false)
  fireEvent(swipe, 'dismiss')
  act(() => finishEarlierSwipe())
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '개인정보 안내 닫기' }))
  expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(true)
})

test.each(['google', 'kakao'] as const)('%s authentication blocks swipe navigation until it finishes', async provider => {
  let finish!: (success: boolean) => void
  const signIn = provider === 'google' ? mockGoogleSignIn : mockKakaoSignIn
  signIn.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await enterPhoneStep()
  fireEvent.press(screen.getByRole('tab', { name: provider === 'google' ? 'Google 계정' : '카카오톡' }))
  fireEvent.press(screen.getByRole('button', { name: provider === 'google' ? 'Google로 계속하기' : '카카오로 계속하기' }))
  await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(false)
  fireEvent(screen.getByTestId('auth-back-swipe'), 'dismiss')
  expect(screen.queryByText('언어와 국가를 선택해 주세요')).toBeNull()
  await act(async () => finish(false))
  expect(screen.getByTestId('auth-back-swipe').props.enabled).toBe(true)
  fireEvent(screen.getByTestId('auth-back-swipe'), 'dismiss')
  await screen.findByText('언어와 국가를 선택해 주세요')
})

test('Expo Go sends SMS and requires verification before authorizing its separate random-key account', async () => {
  mockExpoGoTesting.mockReturnValue(true)
  mockKey.mockResolvedValue('e'.repeat(64))
  mockReinstallIdentity.mockResolvedValue({ platform: 'web', identifier: null })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  expect(screen.queryByText(/Expo Go 테스트 모드/)).toBeNull()
  expect(screen.getByText(/같은 Google·카카오 계정은 다른 휴대폰에서도 기존 포인트와 대화를 이어 씁니다/)).toBeTruthy()
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  expect(mockSend).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockRpc).not.toHaveBeenCalledWith('authorize_device_account_v2', expect.anything())
  fireEvent.changeText(screen.getByLabelText('SMS code'), '123456')
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockVerify).toHaveBeenCalledWith({ phone: '+821012345678', token: '123456', type: 'sms' })
  expect(mockRpc).toHaveBeenCalledWith('authorize_device_account_v2', { device_secret: 'e'.repeat(64), device_platform: 'web', reinstall_identifier: null })
  expect(screen.queryByText(/Expo Go/)).toBeNull()
})

test.each(['ko', 'en'] as const)('Expo Go uses the standalone authenticated layout without an extra safe-area banner in %s', async language => {
  mockSession = { user: { id: 'AuthID', is_anonymous: false } }
  const app = <PhoneAuthGate language={language}><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>
  const standalone = render(app)
  await screen.findByText('PRIVATE ACCOUNT DATA')
  const standaloneLayout = standalone.toJSON()
  standalone.unmount()

  mockExpoGoTesting.mockReturnValue(true)
  mockReinstallIdentity.mockResolvedValue({ platform: 'web', identifier: null })
  const expoGo = render(app)
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(expoGo.toJSON()).toEqual(standaloneLayout)
  expect(screen.queryByText(/Expo Go/)).toBeNull()
})

test('Expo Go does not bypass a rejected OTP', async () => {
  mockExpoGoTesting.mockReturnValue(true)
  mockReinstallIdentity.mockResolvedValue({ platform: 'web', identifier: null })
  mockVerify.mockResolvedValue({ error: new Error('invalid code') })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByRole('alert')
  expect(screen.queryByText('PRIVATE ACCOUNT DATA')).toBeNull()
  expect(mockRpc).not.toHaveBeenCalledWith('authorize_device_account_v2', expect.anything())
})

test.each([
  ['ko', '개인정보 처리 안내 보기', '개인정보 안내 닫기', '닫고 인증 계속하기'],
  ['en', 'Read privacy information', 'Close privacy information', 'Close and continue verification'],
] as const)('privacy has fixed close controls outside the scrolling body in %s', async (language, openLabel, closeLabel, doneLabel) => {
  const dismissKeyboard = jest.spyOn(Keyboard, 'dismiss')
  try {
    render(<PhoneAuthGate language={language}><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>)
    fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
    fireEvent.press(screen.getByRole('button', { name: openLabel }))
    expect(dismissKeyboard).toHaveBeenCalled()
    await screen.findByRole('button', { name: closeLabel })
    const body = screen.getByTestId('phone-privacy-body')
    // These controls must never become descendants of the long document again.
    expect(within(body).queryByRole('button')).toBeNull()
    expect(screen.getByRole('header')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: doneLabel }))
    expect(screen.queryByTestId('phone-privacy-body')).toBeNull()
    expect(screen.getByLabelText('Phone number').props.value).toBe('01012345678')
    fireEvent.press(screen.getByRole('button', { name: openLabel }))
    fireEvent.press(await screen.findByRole('button', { name: closeLabel }))
    expect(screen.queryByTestId('phone-privacy-body')).toBeNull()
    expect(mockSend).not.toHaveBeenCalled()
  } finally { dismissKeyboard.mockRestore() }
})

test('system dismissal of privacy returns to the pending OTP without sending another message', async () => {
  Object.assign(Platform, { OS: 'android' })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  fireEvent.press(screen.getByText('개인정보 처리 안내 보기'))
  await screen.findByTestId('phone-privacy-body')
  fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose')
  expect(screen.queryByTestId('phone-privacy-body')).toBeNull()
  expect(screen.getByLabelText('SMS code').props.value).toBe('123456')
  expect(screen.getByRole('button', { name: /^(인증번호 받기|Send SMS code)$/ })).toBeDisabled()
  expect(mockSend).toHaveBeenCalledTimes(1)
})

test.each([
  ['ko', '인증번호 받기', '인증번호 확인', '개인정보 처리 안내 보기'],
  ['en', 'Send SMS code', 'Verify code', 'Read privacy information'],
] as const)('phone and OTP controls precede supporting information in %s', async (language, sendLabel, verifyLabel, privacyLabel) => {
  render(<PhoneAuthGate language={language}><Text>PRIVATE ACCOUNT DATA</Text></PhoneAuthGate>)
  await screen.findByLabelText('Phone number')
  const assertSections = () => {
    const form = within(screen.getByTestId('phone-auth-form'))
    const information = within(screen.getByTestId('phone-auth-information'))
    expect(form.getByLabelText('Phone number')).toBeTruthy()
    expect(form.queryByRole('button', { name: privacyLabel })).toBeNull()
    expect(information.getByRole('button', { name: privacyLabel })).toBeTruthy()
    const tree = JSON.stringify(screen.toJSON())
    expect(tree.indexOf('phone-auth-form')).toBeLessThan(tree.indexOf('phone-auth-information'))
    return form
  }
  const form = assertSections()
  expect(form.getByLabelText('SMS code').props.editable).toBe(false)
  expect(form.getByRole('button', { name: verifyLabel })).toBeDisabled()
  const editLabel = language === 'ko' ? '번호수정' : 'Edit number'
  const summary = within(screen.getByTestId('phone-privacy-summary'))
  expect(summary.getByRole('button', { name: editLabel })).toBeDisabled()
  expect(form.queryByRole('button', { name: editLabel })).toBeNull()
  fireEvent.press(form.getByRole('button', { name: verifyLabel }))
  expect(mockVerify).not.toHaveBeenCalled()
  fireEvent.changeText(form.getByLabelText('Phone number'), '01012345678')
  fireEvent.press(form.getByRole('button', { name: sendLabel }))
  await waitForSmsInput()
  const otpForm = assertSections()
  expect(otpForm.getByLabelText('SMS code')).toBeTruthy()
  expect(otpForm.getByRole('button', { name: sendLabel })).toBeDisabled()
  expect(otpForm.getByRole('button', { name: verifyLabel })).toBeDisabled()
  expect(summary.getByRole('button', { name: editLabel })).not.toBeDisabled()
  const verification = screen.getByTestId('phone-verification-controls')
  expect(within(verification).getByTestId('phone-resend-countdown')).toBeTruthy()
  const tree = JSON.stringify(screen.toJSON())
  expect(tree.indexOf(verifyLabel)).toBeLessThan(tree.indexOf('phone-resend-countdown'))
})

test('editing the phone keeps both input rows visible but disables verification until another SMS is sent', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  expect(screen.getByLabelText('SMS code').props.editable).toBe(false)
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '123456')
  expect(screen.getByRole('button', { name: '인증번호 확인' })).not.toBeDisabled()
  fireEvent.press(screen.getByText('번호수정'))
  await waitFor(() => expect(screen.getByLabelText('Phone number').props.editable).toBe(true))
  expect(screen.getByLabelText('SMS code').props.value).toBe('')
  expect(screen.getByLabelText('SMS code').props.editable).toBe(false)
  expect(screen.getByRole('button', { name: '인증번호 확인' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '인증번호 받기' })).toBeDisabled()
  fireEvent.press(screen.getByText('인증번호 확인'))
  expect(mockVerify).not.toHaveBeenCalled()
  expect(mockSend).toHaveBeenCalledTimes(1)
})

test('SMS consent starts before sending and fills the code without submitting verification', async () => {
  mockSend.mockImplementation(async () => {
    expect(mockPrepareSmsAutofill).toHaveBeenCalledTimes(1)
    return { error: null }
  })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  act(() => mockPrepareSmsAutofill.mock.calls[0][0]('246810'))
  expect(screen.getByLabelText('SMS code').props.value).toBe('246810')
  expect(mockVerify).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('인증번호 확인'))
  await screen.findByText('PRIVATE ACCOUNT DATA')
  expect(mockStopSmsAutofill).toHaveBeenCalled()
  expect(mockVerify).toHaveBeenCalledWith({ phone: '+821012345678', token: '246810', type: 'sms' })
})

test('an SMS arriving before the send response is retained until the form is ready', async () => {
  mockSend.mockImplementation(async () => {
    mockPrepareSmsAutofill.mock.calls[0][0]('246810')
    return { error: null }
  })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  expect((await waitForSmsInput()).props.value).toBe('246810')
  expect(mockVerify).not.toHaveBeenCalled()
})

test('late SMS consent cannot overwrite a manually entered code', async () => {
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  fireEvent.changeText(await waitForSmsInput(), '654321')
  expect(mockStopSmsAutofill).toHaveBeenCalled()
  act(() => mockPrepareSmsAutofill.mock.calls[0][0]('246810'))
  expect(screen.getByLabelText('SMS code').props.value).toBe('654321')
})

test('failed sending stops the consent listener and still permits manual retry', async () => {
  mockSend.mockResolvedValue({ error: new Error('provider unavailable') })
  mount()
  fireEvent.changeText(await screen.findByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await screen.findByRole('alert')
  expect(mockStopSmsAutofill).toHaveBeenCalled()
  act(() => mockPrepareSmsAutofill.mock.calls[0][0]('246810'))
  expect(screen.getByLabelText('SMS code').props.value).toBe('')
  expect(screen.getByRole('button', { name: '인증번호 받기' })).not.toBeDisabled()
})

test('leaving the auth screen cancels SMS autofill without resetting the code entry', async () => {
  await enterPhoneStep()
  fireEvent.changeText(screen.getByLabelText('Phone number'), '01012345678')
  fireEvent.press(screen.getByText('인증번호 받기'))
  await waitForSmsInput()
  fireEvent.press(screen.getByRole('button', { name: '언어·국가 선택으로 돌아가기' }))
  expect(mockStopSmsAutofill).toHaveBeenCalled()
  act(() => mockPrepareSmsAutofill.mock.calls[0][0]('246810'))
  fireEvent.press(await screen.findByText('저장하고 계속하기'))
  expect((await waitForSmsInput()).props.value).toBe('')
  expect(mockSend).toHaveBeenCalledTimes(1)
})

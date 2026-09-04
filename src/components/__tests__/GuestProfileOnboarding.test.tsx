import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { GuestProfileOnboarding } from '../GuestProfileOnboarding'
import { AuthorizedAccountContext } from '../../lib/authorizedAccount'

const mockRpc = jest.fn()
const mockProfile = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
jest.mock('../../lib/supabase', () => ({ isSupabaseConfigured: true, supabase: {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: () => ({ select: (...args: unknown[]) => { mockSelect(...args); return { eq: (...values: unknown[]) => { mockEq(...values); return { maybeSingle: () => mockProfile() } } } } }),
} }))
jest.mock('../../lib/profilePhoto', () => ({ pickProfilePhoto: jest.fn(), uploadProfilePhoto: jest.fn(), ProfilePhotoPermissionError: class extends Error {} }))
jest.mock('../../lib/observability', () => ({ captureAppError: jest.fn(), addAppBreadcrumb: jest.fn() }))
jest.mock('../../i18n', () => ({ useI18n: () => ({ language: 'ko' }) }))
jest.mock('../../i18n/localizedUi', () => ({ Text: require('react-native').Text, TextInput: require('react-native').TextInput }))
jest.mock('../AgePickerSheet', () => ({ AgePickerSheet: () => null }))
jest.mock('../AccountSwitchButton', () => ({ AccountSwitchButton: () => null }))
const id = '10000000-0000-4000-8000-000000000001'
const savedProfile = { nickname: '기존회원', birth_year: 1990, gender: 'male', avatar_url: null, welcome_points_claimed: true }
const onComplete = jest.fn()
const mount = (accountId: string | null = id) => render(<AuthorizedAccountContext.Provider value={accountId}><GuestProfileOnboarding onComplete={onComplete} /></AuthorizedAccountContext.Provider>)
beforeEach(() => {
  jest.clearAllMocks()
  mockRpc.mockReset().mockImplementation(async name => ({ data: name === 'current_account_id' ? id : null, error: null }))
  mockProfile.mockReset().mockResolvedValue({ data: savedProfile, error: null })
})

test('returning profile reuses the authorized ID and skips an already-completed welcome claim', async () => {
  mount()
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['refresh_my_suspension'])
  expect(mockEq).toHaveBeenCalledWith('id', id)
  expect(mockSelect).toHaveBeenCalledWith(expect.stringContaining('welcome_points_claimed'))
  expect(onComplete).toHaveBeenCalledWith({ nickname: '기존회원', age: new Date().getFullYear() - 1990, gender: 'male', avatarUrl: null })
})

test('outside the authorized gate the profile still resolves an account through the server', async () => {
  mount(null)
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['current_account_id', 'refresh_my_suspension'])
})

test('an incomplete welcome claim is still finished before opening the app', async () => {
  mockProfile.mockResolvedValue({ data: { ...savedProfile, welcome_points_claimed: false }, error: null })
  mount()
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['refresh_my_suspension', 'claim_account_welcome_points'])
})

test('profile lookup failure shows retry instead of new-account onboarding', async () => {
  mockProfile.mockResolvedValueOnce({ data: null, error: new Error('offline') })
  const screen = mount()
  const retry = await screen.findByText('다시 불러오기')
  expect(onComplete).not.toHaveBeenCalled()
  expect(screen.queryByText('프로필을 알려주세요')).toBeNull()
  fireEvent.press(retry)
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  expect(mockProfile).toHaveBeenCalledTimes(2)
})

test('a delayed profile response after unmount neither grants rewards nor completes onboarding', async () => {
  let finish!: (value: any) => void
  mockProfile.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const screen = mount()
  await waitFor(() => expect(mockProfile).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('app-startup-screen')).toBeTruthy()
  screen.unmount()
  await act(async () => finish({ data: { ...savedProfile, welcome_points_claimed: false }, error: null }))
  expect(onComplete).not.toHaveBeenCalled()
  expect(mockRpc).not.toHaveBeenCalledWith('claim_account_welcome_points')
})

test('suspension-check failure does not read or show the profile', async () => {
  mockRpc.mockResolvedValue({ error: new Error('access denied') })
  const screen = mount()
  await screen.findByText('다시 불러오기')
  expect(mockProfile).not.toHaveBeenCalled()
  expect(onComplete).not.toHaveBeenCalled()
})

test('new profile onboarding relies on Android resize without fixed focus scrolling', async () => {
  const originalPlatform = Platform.OS
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  mockProfile.mockResolvedValue({ data: null, error: null })
  const screen = mount()
  try {
    await screen.findByText('프로필을 알려주세요')
    const viewport = screen.UNSAFE_getByType(KeyboardAvoidingView)
    expect(viewport.props.enabled).toBe(true)
    expect(viewport.props.behavior).toBe('padding')
    expect(screen.UNSAFE_getByType(ScrollView).props.automaticallyAdjustKeyboardInsets).toBe(false)
    expect(screen.getByPlaceholderText('2~9자로 입력').props.onFocus).toBeUndefined()
  } finally {
    screen.unmount()
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
  }
})

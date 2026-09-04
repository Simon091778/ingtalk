import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { RewardedAdButton } from '../RewardedAdButton'
import { supabase } from '../../lib/supabase'
import { addAppBreadcrumb, captureAppError } from '../../lib/observability'

jest.mock('react-native', () => {
  const original = jest.requireActual('react-native')
  Object.defineProperty(original.Platform, 'OS', { configurable: true, value: 'android' })
  return original
})
jest.mock('expo-constants', () => ({ __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }))
jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn() } }))
jest.mock('../../lib/mobileAds', () => ({ initializeMobileAds: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../lib/observability', () => ({ addAppBreadcrumb: jest.fn(), captureAppError: jest.fn() }))
const mockListeners: Record<string, (...args: unknown[]) => void> = {}
const mockAd = { loaded: true, load: jest.fn(), show: jest.fn().mockResolvedValue(undefined), removeAllListeners: jest.fn(), addAdEventListener: jest.fn((event, callback) => { mockListeners[event] = callback }) }
const mockCreate = jest.fn((..._args: unknown[]) => mockAd)
jest.mock('react-native-google-mobile-ads', () => ({
  AdEventType: { CLOSED: 'closed', ERROR: 'error', OPENED: 'opened' }, RewardedAdEventType: { LOADED: 'loaded', EARNED_REWARD: 'earned' },
  RewardedAd: { createForAdRequest: (...args: unknown[]) => mockCreate(...args) }, TestIds: { REWARDED: 'test-ad' },
}))
const rpc = jest.mocked(supabase!.rpc)
const onBalanceChanged = jest.fn()
let available: boolean
let receipt: string
const previousDev = __DEV__

beforeEach(() => {
  Object.assign(globalThis, { __DEV__: false })
  jest.clearAllMocks()
  available = true
  receipt = 'pending'
  for (const key of Object.keys(mockListeners)) delete mockListeners[key]
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  rpc.mockImplementation((name: string) => Promise.resolve({ data:
    name === 'my_rewarded_ad_status' ? [{ available }]
      : name === 'my_point_balance' ? 0
        : name === 'my_rewarded_ad_claim_status' ? receipt
          : { available: true, token: 'ticket', user_id: 'original-account', custom_data: 'opaque-claim' }, error: null }) as never)
})
afterEach(() => { Object.assign(globalThis, { __DEV__: previousDev }); jest.restoreAllMocks() })

test('ad uses server-bound account and opaque claim, not a client device identifier', async () => {
  render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  expect(rpc).toHaveBeenCalledWith('prepare_rewarded_ad_claim')
  expect(mockCreate.mock.calls[0]?.[1]).toMatchObject({ serverSideVerificationOptions: { userId: 'original-account', customData: 'opaque-claim' } })
})

test('denied device reward is not announced as a 50P grant', async () => {
  render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  available = false
  receipt = 'denied'
  act(() => mockListeners.earned!())
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('광고 보상 확인', expect.stringContaining('이미 광고 보상을 받았어요')))
  expect(rpc).toHaveBeenCalledWith('my_rewarded_ad_claim_status', { claim_token: 'ticket' })
  expect(Alert.alert).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('50P가 충전'))
})

test('a confirmed ticket displays the actual reward confirmation', async () => {
  render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  available = false
  receipt = 'awarded'
  act(() => mockListeners.earned!())
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('광고 보상 확인', '광고 시청 보상 50P가 충전되었습니다.'))
})

test('rechecks shared device cooldown before showing a previously loaded ad', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  act(() => mockListeners.loaded!())
  available = false
  fireEvent.press(screen.getByText('광고 시청 · +50P'))
  await waitFor(() => expect(screen.getByText('광고 완료 · 24시간 후')).toBeTruthy())
  expect(mockAd.show).not.toHaveBeenCalled()
})

test('rapid presses cannot show the same loaded ad twice', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  act(() => mockListeners.loaded!())

  const buttonLabel = screen.getByText('광고 시청 · +50P')
  fireEvent.press(buttonLabel)
  fireEvent.press(buttonLabel)

  await waitFor(() => expect(mockAd.show).toHaveBeenCalledTimes(1))
})

test('loaded state does not restart ad preparation', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalledTimes(1))
  act(() => mockListeners.loaded!())
  await waitFor(() => expect(screen.getByText('광고 시청 · +50P')).toBeTruthy())
  expect(mockCreate).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls.filter(([name]) => name === 'prepare_rewarded_ad_claim')).toHaveLength(1)
})

test('no ad is requested when server ticket preparation reports cooldown', async () => {
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'my_rewarded_ad_status' ? [{ available: true }] : name === 'prepare_rewarded_ad_claim' ? { available: false } : 0, error: null }) as never)
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(screen.getByText('광고 완료 · 24시간 후')).toBeTruthy())
  expect(mockCreate).not.toHaveBeenCalled()
})

test('no-fill remains retryable without being reported as an app failure', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  const noFillError = Object.assign(new Error('[googleMobileAds/no-fill] No fill.'), {
    code: 'googleMobileAds/no-fill',
    namespace: 'googleMobileAds',
    userInfo: { code: 'no-fill' },
  })
  act(() => mockListeners.error!(noFillError))
  await waitFor(() => expect(screen.getByText('광고 다시 불러오기')).toBeTruthy())
  expect(captureAppError).not.toHaveBeenCalledWith(expect.anything(), 'ads', 'rewarded_ad')
  expect(addAppBreadcrumb).toHaveBeenCalledWith('adflow:no_fill', expect.objectContaining({
    errorCode: 'googleMobileAds/no-fill',
    nativeErrorCode: 'no-fill',
    errorDomain: 'googleMobileAds',
    errorSummary: '[googleMobileAds/no-fill] No fill.',
    retryable: true,
  }))
  expect(rpc).toHaveBeenCalledWith('cancel_rewarded_ad_claim', { claim_token: 'ticket' })
})

test('reload creates and loads a fresh ad generation after a no-fill error', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalledTimes(1))
  const staleError = mockListeners.error!
  act(() => staleError(new Error('[googleMobileAds/no-fill] No fill.')))
  await waitFor(() => expect(screen.getByText('광고 다시 불러오기')).toBeTruthy())

  fireEvent.press(screen.getByText('광고 다시 불러오기'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2))
  expect(mockAd.load).toHaveBeenCalledTimes(2)
  expect(rpc).toHaveBeenCalledWith('reset_rewarded_ad_claim')

  act(() => mockListeners.loaded!())
  await waitFor(() => expect(screen.getByText('광고 시청 · +50P')).toBeTruthy())
  act(() => staleError(new Error('late error from old ad')))
  expect(screen.getByText('광고 시청 · +50P')).toBeTruthy()
})

test('duplicate earned events start only one server verification', async () => {
  render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  available = false
  receipt = 'awarded'

  act(() => {
    mockListeners.earned!()
    mockListeners.earned!()
  })

  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('광고 보상 확인', '광고 시청 보상 50P가 충전되었습니다.'))
  expect(rpc.mock.calls.filter(([name]) => name === 'my_rewarded_ad_claim_status')).toHaveLength(1)
  expect(Alert.alert).toHaveBeenCalledTimes(1)
})

test('reward is preserved when closed arrives immediately before earned', async () => {
  const screen = render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalled())
  available = false
  receipt = 'awarded'

  act(() => {
    mockListeners.closed!()
    mockListeners.earned!()
  })

  await waitFor(() => expect(screen.getByText('광고 완료 · 24시간 후')).toBeTruthy())
  expect(Alert.alert).toHaveBeenCalledWith('광고 보상 확인', '광고 시청 보상 50P가 충전되었습니다.')
})

test('closed development ad settles its claim before loading a new single-use instance', async () => {
  Object.assign(globalThis, { __DEV__: true })
  render(<RewardedAdButton language="ko" onBalanceChanged={onBalanceChanged} />)
  await waitFor(() => expect(mockAd.load).toHaveBeenCalledTimes(1))

  act(() => {
    mockListeners.earned!()
    mockListeners.closed!()
  })

  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2))
  expect(mockAd.load).toHaveBeenCalledTimes(2)
  expect(rpc).toHaveBeenCalledWith('cancel_rewarded_ad_claim', { claim_token: 'ticket' })
})

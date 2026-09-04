import { act, fireEvent, render } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'
import { BoardBannerAd } from '../BoardBannerAd'
import { initializeMobileAds, mobileAdsSupported } from '../../lib/mobileAds'
import { captureAppError } from '../../lib/observability'

jest.mock('../../lib/mobileAds', () => ({
  initializeMobileAds: jest.fn(), mobileAdsSupported: jest.fn(),
}))
jest.mock('../../lib/observability', () => ({ captureAppError: jest.fn(), addAppBreadcrumb: jest.fn() }))
jest.mock('react-native-google-mobile-ads', () => ({
  BannerAd: (props: object) => require('react').createElement(require('react-native').View, { ...props, testID: 'native-banner' }),
  BannerAdSize: { BANNER: 'BANNER' }, TestIds: { BANNER: 'test-banner' },
}))

const noFill = Object.assign(new Error('No ad inventory'), { code: 'googleMobileAds/error-code-no-fill' })
let appStateChanged: (state: AppStateStatus) => void
let removeListener: jest.Mock

beforeEach(() => {
  jest.useFakeTimers()
  jest.mocked(mobileAdsSupported).mockReturnValue(true)
  jest.mocked(initializeMobileAds).mockResolvedValue(undefined)
  removeListener = jest.fn()
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    appStateChanged = callback
    return { remove: removeListener }
  })
})
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

async function openBanner() {
  const screen = render(<BoardBannerAd language="ko" />)
  await act(async () => {})
  return screen
}
async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms) })
}

it('waits for SDK initialization and shows the label only after the ad loads', async () => {
  let ready!: () => void
  jest.mocked(initializeMobileAds).mockReturnValueOnce(new Promise(resolve => { ready = resolve }))
  const screen = render(<BoardBannerAd language="ko" />)
  expect(screen.queryByTestId('native-banner')).toBeNull()
  expect(screen.queryByText('광고')).toBeNull()
  await act(async () => { ready() })
  expect(screen.getByTestId('native-banner').props.unitId).toBe('test-banner')
  expect(screen.queryByText('광고')).toBeNull()
  fireEvent(screen.getByTestId('native-banner'), 'adLoaded', { width: 320, height: 50 })
  expect(screen.getByText('광고')).toBeTruthy()
})

it('retries a no-fill after 60 seconds and can display the recovered ad', async () => {
  const screen = await openBanner()
  fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', noFill)
  expect(screen.queryByTestId('native-banner')).toBeNull()
  expect(screen.queryByText('광고')).toBeNull()
  expect(captureAppError).toHaveBeenCalledWith(noFill, 'ads', 'board_banner', expect.objectContaining({
    errorCode: noFill.code, attempt: 1, retryDelaySeconds: 60,
  }))
  await advance(59_999)
  expect(screen.queryByTestId('native-banner')).toBeNull()
  await advance(1)
  fireEvent(screen.getByTestId('native-banner'), 'adLoaded', { width: 320, height: 50 })
  expect(screen.getByText('광고')).toBeTruthy()
  await advance(600_000)
  expect(initializeMobileAds).toHaveBeenCalledTimes(2)
})

it('caps consecutive failures at three retries with increasing delays', async () => {
  const screen = await openBanner()
  for (const delay of [60_000, 120_000, 240_000]) {
    fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', noFill)
    await advance(delay - 1)
    expect(screen.queryByTestId('native-banner')).toBeNull()
    await advance(1)
    expect(screen.getByTestId('native-banner')).toBeTruthy()
  }
  fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', noFill)
  await advance(3_600_000)
  expect(screen.queryByTestId('native-banner')).toBeNull()
  expect(initializeMobileAds).toHaveBeenCalledTimes(4)
})

it('does not retry invalid requests', async () => {
  const screen = await openBanner()
  fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', Object.assign(new Error('Invalid ID'), {
    code: 'googleMobileAds/error-code-invalid-request',
  }))
  await advance(600_000)
  expect(initializeMobileAds).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('native-banner')).toBeNull()
})

it('pauses retries in the background and cancels pending work on close', async () => {
  const screen = await openBanner()
  fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', noFill)
  act(() => appStateChanged('background'))
  await advance(120_000)
  expect(initializeMobileAds).toHaveBeenCalledTimes(1)
  act(() => appStateChanged('active'))
  await advance(0)
  expect(screen.getByTestId('native-banner')).toBeTruthy()
  fireEvent(screen.getByTestId('native-banner'), 'adFailedToLoad', noFill)
  screen.unmount()
  await advance(600_000)
  expect(initializeMobileAds).toHaveBeenCalledTimes(2)
  expect(removeListener).toHaveBeenCalledTimes(1)
})

it('retries initialization failures without rendering a native banner early', async () => {
  jest.mocked(initializeMobileAds).mockRejectedValueOnce(new Error('SDK unavailable'))
  const screen = await openBanner()
  expect(screen.queryByTestId('native-banner')).toBeNull()
  await advance(60_000)
  expect(screen.getByTestId('native-banner')).toBeTruthy()
})

it('does not start ads on unsupported platforms or Expo Go', async () => {
  jest.mocked(mobileAdsSupported).mockReturnValue(false)
  const screen = await openBanner()
  expect(initializeMobileAds).not.toHaveBeenCalled()
  expect(screen.queryByTestId('native-banner')).toBeNull()
})

it('ignores SDK completion after the screen closes', async () => {
  let ready!: () => void
  jest.mocked(initializeMobileAds).mockReturnValueOnce(new Promise(resolve => { ready = resolve }))
  const screen = render(<BoardBannerAd language="ko" />)
  screen.unmount()
  await act(async () => { ready() })
  await advance(600_000)
  expect(initializeMobileAds).toHaveBeenCalledTimes(1)
  expect(removeListener).toHaveBeenCalledTimes(1)
  expect(captureAppError).not.toHaveBeenCalled()
})

const mockInitialize = jest.fn()
const mockLoadSdk = jest.fn()
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }))
jest.mock('expo-constants', () => ({
  __esModule: true, default: { executionEnvironment: 'standalone' },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}))
jest.mock('react-native-google-mobile-ads', () => {
  mockLoadSdk()
  return { default: () => ({ initialize: mockInitialize }) }
})

beforeEach(() => {
  jest.resetModules()
  mockInitialize.mockReset().mockResolvedValue([])
  mockLoadSdk.mockClear()
})

it('shares one initialization promise between concurrent and later callers', async () => {
  const { initializeMobileAds } = require('../mobileAds') as typeof import('../mobileAds')
  const first = initializeMobileAds()
  expect(initializeMobileAds()).toBe(first)
  await first
  await initializeMobileAds()
  expect(mockInitialize).toHaveBeenCalledTimes(1)
})

it('allows another initialization attempt after rejection', async () => {
  mockInitialize.mockRejectedValueOnce(new Error('Unavailable'))
  const { initializeMobileAds } = require('../mobileAds') as typeof import('../mobileAds')
  await expect(initializeMobileAds()).rejects.toThrow('Unavailable')
  await expect(initializeMobileAds()).resolves.toBeUndefined()
  expect(mockInitialize).toHaveBeenCalledTimes(2)
})

it.each([['ios', 'standalone'], ['web', 'standalone'], ['android', 'storeClient']])(
  'does not load the native SDK for %s/%s', async (os, executionEnvironment) => {
    require('react-native').Platform.OS = os
    require('expo-constants').default.executionEnvironment = executionEnvironment
    const { mobileAdsSupported, initializeMobileAds } = require('../mobileAds') as typeof import('../mobileAds')
    expect(mobileAdsSupported()).toBe(false)
    await initializeMobileAds()
    expect(mockLoadSdk).not.toHaveBeenCalled()
  },
)

import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { isExpoGoAuthTesting } from '../expoGoAuth'

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { executionEnvironment: 'storeClient' },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}))
const originalDev = __DEV__
afterEach(() => { Object.assign(globalThis, { __DEV__: originalDev }) })

test.each([
  ['ios', 'storeClient', true, true],
  ['android', 'storeClient', true, true],
  ['ios', 'storeClient', false, false],
  ['android', 'storeClient', false, false],
  ['ios', 'standalone', true, false],
  ['android', 'bare', true, false],
  ['web', 'storeClient', true, false],
  ['ios', undefined, true, false],
])('test mode requires a mobile Expo Go development runtime (%s, %s, dev=%s)', (os, environment, dev, expected) => {
  Object.assign(Platform, { OS: os })
  Object.assign(Constants, { executionEnvironment: environment })
  Object.assign(globalThis, { __DEV__: dev })
  expect(isExpoGoAuthTesting()).toBe(expected)
})

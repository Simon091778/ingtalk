import { getDeviceReinstallIdentity } from '../deviceReinstallIdentity'
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as Crypto from 'expo-crypto'
const mockExpoGoTesting = jest.fn()
jest.mock('../expoGoAuth', () => ({ isExpoGoAuthTesting: () => mockExpoGoTesting() }))
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }))
jest.mock('expo-application', () => ({ __esModule: true, applicationId: 'kr.ingtalk.app', getAndroidId: jest.fn() }))
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn(async (_algorithm, input) => require('node:crypto').createHash('sha256').update(input).digest('hex')),
}))
beforeEach(() => {
  mockExpoGoTesting.mockReturnValue(false)
  Object.assign(Application, { applicationId: 'kr.ingtalk.app' })
  Object.assign(Platform, { OS: 'android' })
  ;(Application.getAndroidId as jest.Mock).mockReturnValue('abcdef0123456789')
})
test('Android reinstall gets the same identifier even when random installation key is lost', async () => {
  const before = await getDeviceReinstallIdentity('a'.repeat(64))
  const after = await getDeviceReinstallIdentity('b'.repeat(64))
  expect(after).toEqual(before)
  expect(after.platform).toBe('android')
  expect(after.identifier).toMatch(/^[a-f0-9]{64}$/)
  expect(after.identifier).not.toContain('abcdef0123456789')
  expect(Crypto.digestStringAsync).toHaveBeenCalledWith('SHA-256', 'ingtalk-reinstall-v1:android:kr.ingtalk.app:abcdef0123456789')
})
test('another Android device or OS user has a different recovery identifier', async () => {
  const before = await getDeviceReinstallIdentity('a'.repeat(64))
  ;(Application.getAndroidId as jest.Mock).mockReturnValue('1234567890abcdef')
  expect(await getDeviceReinstallIdentity('a'.repeat(64))).not.toEqual(before)
})
test.each([null, '', '0', '0000000000000000', '9774d56d682e549c', 'not-an-id'])('unavailable/common invalid Android ID (%s) fails closed', async value => {
  ;(Application.getAndroidId as jest.Mock).mockReturnValue(value)
  await expect(getDeviceReinstallIdentity('a'.repeat(64))).rejects.toThrow('device_identity_unavailable')
})
test('iOS uses the surviving device-only Keychain key, not resettable IDFV', async () => {
  Object.assign(Platform, { OS: 'ios' })
  const before = await getDeviceReinstallIdentity('a'.repeat(64))
  expect(await getDeviceReinstallIdentity('a'.repeat(64))).toEqual(before)
  expect(await getDeviceReinstallIdentity('b'.repeat(64))).not.toEqual(before)
  expect(Application.getAndroidId).not.toHaveBeenCalled()
})
test('browser does not pretend to prove native physical device identity', async () => {
  Object.assign(Platform, { OS: 'web' })
  expect(await getDeviceReinstallIdentity('a'.repeat(64))).toEqual({ platform: 'web', identifier: null })
})

test.each(['ios', 'android'])('Expo Go on %s uses random-key authentication without a native recovery claim', async os => {
  Object.assign(Platform, { OS: os })
  Object.assign(Application, { applicationId: 'host.exp.Exponent' })
  mockExpoGoTesting.mockReturnValue(true)
  expect(await getDeviceReinstallIdentity('a'.repeat(64))).toEqual({ platform: 'web', identifier: null })
  expect(Application.getAndroidId).not.toHaveBeenCalled()
  expect(Crypto.digestStringAsync).not.toHaveBeenCalled()
})

test('a non-Expo native app with the wrong application ID still fails closed', async () => {
  Object.assign(Application, { applicationId: 'another.app' })
  await expect(getDeviceReinstallIdentity('a'.repeat(64))).rejects.toThrow('device_identity_unavailable')
})

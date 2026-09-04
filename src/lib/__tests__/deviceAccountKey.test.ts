import { getDeviceAccountKey } from '../deviceAccountKey'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
const mockExpoGoTesting = jest.fn()
jest.mock('../expoGoAuth', () => ({ isExpoGoAuthTesting: () => mockExpoGoTesting() }))
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only', getItemAsync: jest.fn(), setItemAsync: jest.fn() }))
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }))
let saved: string | null
beforeEach(() => {
  jest.resetAllMocks()
  mockExpoGoTesting.mockReturnValue(false)
  saved = null
  ;(SecureStore.getItemAsync as jest.Mock).mockImplementation(async () => saved)
  ;(SecureStore.setItemAsync as jest.Mock).mockImplementation(async (_key, value) => { saved = value })
  ;(Crypto.getRandomBytesAsync as jest.Mock).mockResolvedValue(new Uint8Array(32).fill(0xab))
})
test('concurrent callers create and persist exactly one device-only 256-bit credential', async () => {
  const [a, b] = await Promise.all([getDeviceAccountKey(), getDeviceAccountKey()])
  expect(a).toBe('ab'.repeat(32)); expect(b).toBe(a)
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1)
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledWith(32)
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith('ingtalk.device-account-key.v1', a, { keychainAccessible: 'device-only' })
  expect(await getDeviceAccountKey()).toBe(a)
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1)
})
test('corrupt or unreadable storage never silently replaces an account credential', async () => {
  saved = 'broken'
  await expect(getDeviceAccountKey()).rejects.toThrow('device_storage_unavailable')
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  ;(SecureStore.getItemAsync as jest.Mock).mockRejectedValue(new Error('locked'))
  await expect(getDeviceAccountKey()).rejects.toThrow('device_storage_unavailable')
  expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled()
})
test('failed writes or readback mismatch never return an unpersisted key', async () => {
  ;(SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('full'))
  await expect(getDeviceAccountKey()).rejects.toThrow('device_storage_unavailable')
  ;(SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined)
  await expect(getDeviceAccountKey()).rejects.toThrow('device_storage_unavailable')
})

test('Expo Go keeps a separate persisted key and never overwrites a production key', async () => {
  const productionKey = 'c'.repeat(64)
  const values = new Map([['ingtalk.device-account-key.v1', productionKey]])
  ;(SecureStore.getItemAsync as jest.Mock).mockImplementation(async key => values.get(key) ?? null)
  ;(SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, value) => { values.set(key, value) })
  mockExpoGoTesting.mockReturnValue(true)
  const testKey = await getDeviceAccountKey()
  expect(testKey).not.toBe(productionKey)
  expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith('ingtalk.device-account-key.v1', expect.anything())
  expect(values.get('ingtalk.expo-go.device-account-key.v1')).toBe(testKey)
  expect(await getDeviceAccountKey()).toBe(testKey)
  mockExpoGoTesting.mockReturnValue(false)
  expect(await getDeviceAccountKey()).toBe(productionKey)
  expect(values.get('ingtalk.device-account-key.v1')).toBe(productionKey)
})

test('corrupt Expo Go credentials still block rather than regenerating or reading production credentials', async () => {
  mockExpoGoTesting.mockReturnValue(true)
  saved = 'broken'
  await expect(getDeviceAccountKey()).rejects.toThrow('device_storage_unavailable')
  expect(SecureStore.getItemAsync).toHaveBeenCalledWith('ingtalk.expo-go.device-account-key.v1', { keychainAccessible: 'device-only' })
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})

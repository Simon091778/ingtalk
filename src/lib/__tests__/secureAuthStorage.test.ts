import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { secureAuthStorage } from '../secureAuthStorage'

const mockStore = new Map<string, string>()
let mockId = 0
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value) }),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key) }),
}))
jest.mock('expo-crypto', () => ({ randomUUID: () => `abcd-${++mockId}` }))

beforeEach(() => { Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true }); mockStore.clear(); jest.clearAllMocks(); Object.defineProperty(globalThis, 'localStorage', { value: { removeItem: jest.fn() }, configurable: true }) })
test('round trips large Unicode sessions without plaintext storage', async () => {
  const value = JSON.stringify({ token: 'a'.repeat(5000), nickname: '한'.repeat(1000) })
  await secureAuthStorage.setItem('session', value)
  expect(await secureAuthStorage.getItem('session')).toBe(value)
  expect([...mockStore.values()].every(part => part.length <= 1000)).toBe(true)
  expect(localStorage.removeItem).toHaveBeenCalledWith('session')
})
test('an interrupted write retains the previously published session', async () => {
  await secureAuthStorage.setItem('session', 'old-session')
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('disk failure'))
  await expect(secureAuthStorage.setItem('session', 'new-session')).rejects.toThrow('disk failure')
  expect(await secureAuthStorage.getItem('session')).toBe('old-session')
})
test('concurrent writes serialize and removal deletes manifest and chunks', async () => {
  await Promise.all([secureAuthStorage.setItem('session', 'first'), secureAuthStorage.setItem('session', 'second')])
  expect(await secureAuthStorage.getItem('session')).toBe('second')
  await secureAuthStorage.removeItem('session')
  expect(await secureAuthStorage.getItem('session')).toBeNull()
  expect(mockStore.size).toBe(0)
})

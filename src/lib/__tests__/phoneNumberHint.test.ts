import { NativeModules, Platform } from 'react-native'
import { requestPhoneNumberHint, supportsPhoneNumberHint } from '../phoneNumberHint'

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }))
const request = jest.fn()
beforeEach(() => {
  Object.assign(Platform, { OS: 'android' })
  NativeModules.IngtalkPhoneNumberHint = { requestPhoneNumber: request }
  request.mockReset()
})

test('normalizes a user-selected number without treating it as authentication', async () => {
  request.mockResolvedValue('010-1234-5678')
  expect(supportsPhoneNumberHint()).toBe(true)
  expect(await requestPhoneNumberHint()).toBe('+821012345678')
})

test.each([null, undefined, {}, '', '+82', '010abc12345678'])('missing or invalid hint %p permits manual input', async value => {
  request.mockResolvedValue(value)
  expect(await requestPhoneNumberHint()).toBeNull()
})

test('provider failure never escapes into the auth error path or logs', async () => {
  request.mockRejectedValue(new Error('provider phone +821012345678'))
  const log = jest.spyOn(console, 'error')
  const warn = jest.spyOn(console, 'warn')
  try {
    expect(await requestPhoneNumberHint()).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  } finally { log.mockRestore(); warn.mockRestore() }
})

test.each(['ios', 'web'])('%s never tries to read a SIM number', async os => {
  Object.assign(Platform, { OS: os })
  expect(supportsPhoneNumberHint()).toBe(false)
  expect(await requestPhoneNumberHint()).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

test('Expo Go or an older binary without the native module still permits manual input', async () => {
  delete NativeModules.IngtalkPhoneNumberHint
  expect(supportsPhoneNumberHint()).toBe(false)
  expect(await requestPhoneNumberHint()).toBeNull()
})

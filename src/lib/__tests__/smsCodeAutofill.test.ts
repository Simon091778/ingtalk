import { NativeModules, Platform } from 'react-native'
import { prepareSmsCodeAutofill } from '../smsCodeAutofill'

const mockRemove = jest.fn()
const mockAddListener = jest.fn()
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: {},
  NativeEventEmitter: jest.fn().mockImplementation(() => ({ addListener: (...args: unknown[]) => mockAddListener(...args) })),
}))
const start = jest.fn()
const stop = jest.fn()
beforeEach(() => {
  jest.useFakeTimers()
  Object.assign(Platform, { OS: 'android' })
  NativeModules.IngtalkSmsConsent = { startListening: start, stopListening: stop, addListener: jest.fn(), removeListeners: jest.fn() }
  start.mockReset().mockResolvedValue(true)
  stop.mockReset()
  mockRemove.mockReset()
  mockAddListener.mockReset().mockReturnValue({ remove: mockRemove })
})
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test('only the current consent result yields a code and releases resources', async () => {
  const onCode = jest.fn()
  const cancel = await prepareSmsCodeAutofill(onCode)
  const id = start.mock.calls[0][0]
  const receive = mockAddListener.mock.calls[0][1]
  expect(mockAddListener.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
  receive({ requestId: 'old', code: '123456' })
  expect(onCode).not.toHaveBeenCalled()
  receive({ requestId: id, code: '123456' })
  receive({ requestId: id, code: '999999' })
  expect(onCode).toHaveBeenCalledTimes(1)
  expect(onCode).toHaveBeenCalledWith('123456')
  expect(mockRemove).toHaveBeenCalledTimes(1)
  cancel()
  expect(stop).toHaveBeenCalledTimes(1)
})

test.each([null, '12345', 'Your code is 123456', 123456])('cancelled or malformed result %p never fills an OTP', async code => {
  const onCode = jest.fn()
  await prepareSmsCodeAutofill(onCode)
  mockAddListener.mock.calls[0][1]({ requestId: start.mock.calls[0][0], code })
  expect(onCode).not.toHaveBeenCalled()
  expect(mockRemove).toHaveBeenCalledTimes(1)
})

test.each(['ios', 'web'])('%s keeps system autofill without starting native SMS consent', async os => {
  Object.assign(Platform, { OS: os })
  const cancel = await prepareSmsCodeAutofill(jest.fn())
  cancel()
  expect(start).not.toHaveBeenCalled()
})

test('Expo Go or an older binary without the module keeps manual entry', async () => {
  delete NativeModules.IngtalkSmsConsent
  await prepareSmsCodeAutofill(jest.fn())
  expect(start).not.toHaveBeenCalled()
})

test('setup rejection is swallowed without blocking SMS sending', async () => {
  start.mockRejectedValue(new Error('unavailable'))
  const cancel = await prepareSmsCodeAutofill(jest.fn())
  cancel()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(mockRemove).toHaveBeenCalledTimes(1)
})

test('a hung setup is bounded and late events are ignored', async () => {
  start.mockReturnValue(new Promise(() => {}))
  const onCode = jest.fn()
  const prepared = prepareSmsCodeAutofill(onCode)
  await jest.advanceTimersByTimeAsync(1500)
  await prepared
  mockAddListener.mock.calls[0][1]({ requestId: start.mock.calls[0][0], code: '123456' })
  expect(onCode).not.toHaveBeenCalled()
  expect(mockRemove).toHaveBeenCalledTimes(1)
})

test('waiting expires after five minutes and explicit cancellation also ignores late codes', async () => {
  const onCode = jest.fn()
  await prepareSmsCodeAutofill(onCode)
  await jest.advanceTimersByTimeAsync(5 * 60_000)
  expect(mockRemove).toHaveBeenCalledTimes(1)
  const cancel = await prepareSmsCodeAutofill(onCode)
  cancel()
  mockAddListener.mock.calls[1][1]({ requestId: start.mock.calls[1][0], code: '123456' })
  expect(onCode).not.toHaveBeenCalled()
})

import { AppState, Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { dismissReadChatNotifications, setActiveChatNotificationRoom, shouldSuppressChatNotification } from '../chatNotificationState'

jest.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: jest.fn(),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
}))

const originalPlatform = Platform.OS
const originalState = AppState.currentState
const originalEnvironment = Constants.executionEnvironment

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  AppState.currentState = 'active'
  Constants.executionEnvironment = ExecutionEnvironment.Standalone
  setActiveChatNotificationRoom('room-a')
})
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
  AppState.currentState = originalState
  Constants.executionEnvironment = originalEnvironment
  setActiveChatNotificationRoom(null)
})

it('suppresses only messages for the room currently visible on Android', () => {
  expect(shouldSuppressChatNotification({ kind: 'message', room_id: 'room-a' })).toBe(true)
  expect(shouldSuppressChatNotification({ kind: 'message', room_id: 'room-b' })).toBe(false)
  expect(shouldSuppressChatNotification({ kind: 'chat_request', room_id: 'room-a' })).toBe(false)
  expect(shouldSuppressChatNotification(undefined)).toBe(false)
  setActiveChatNotificationRoom(null)
  expect(shouldSuppressChatNotification({ kind: 'message', room_id: 'room-a' })).toBe(false)
})

it('does not suppress notifications while backgrounded or on iPhone', () => {
  AppState.currentState = 'background'
  expect(shouldSuppressChatNotification({ kind: 'message', room_id: 'room-a' })).toBe(false)
  AppState.currentState = 'active'
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  expect(shouldSuppressChatNotification({ kind: 'message', room_id: 'room-a' })).toBe(false)
})

it('clears every notification for the read room, preserving other rooms and requests', async () => {
  const item = (identifier: string, kind: string, room_id: string): Notifications.Notification => ({
    date: Date.now(),
    request: { identifier, trigger: null, content: { title: null, subtitle: null, body: null, sound: null, categoryIdentifier: null, data: { kind, room_id } } },
  })
  jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    item('ingtalk-chat-room:room-a', 'message', 'room-a'),
    item('legacy-notification', 'message', 'room-a'),
    item('other-room', 'message', 'room-b'),
    item('request', 'chat_request', 'room-a'),
  ])
  await dismissReadChatNotifications('room-a')
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledTimes(2)
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('ingtalk-chat-room:room-a')
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('legacy-notification')
})

it('does not access native notifications in Expo Go or on iPhone', async () => {
  Constants.executionEnvironment = ExecutionEnvironment.StoreClient
  await dismissReadChatNotifications('room-a')
  Constants.executionEnvironment = ExecutionEnvironment.Standalone
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  await dismissReadChatNotifications('room-a')
  expect(Notifications.getPresentedNotificationsAsync).not.toHaveBeenCalled()
})

it('also clears the stable room ID before a just-posted notification appears in the OS snapshot', async () => {
  jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValueOnce([])
  await dismissReadChatNotifications('room-a')
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('ingtalk-chat-room:room-a')
})

it('does not break chat when notification cleanup fails', async () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValueOnce(new Error('native failure'))
  await expect(dismissReadChatNotifications('room-a')).resolves.toBeUndefined()
  expect(warning).toHaveBeenCalled()
  warning.mockRestore()
})

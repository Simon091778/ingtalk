import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { NotificationSettings } from '../NotificationSettings'

const mockLoad = jest.fn()
const mockSave = jest.fn()

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))
jest.mock('../SwipeDismissView', () => ({
  SwipeDismissView: ({ children }: { children: React.ReactNode }) => children,
}))
jest.mock('../../lib/notificationPreferences', () => ({
  defaultNotificationPreferences: {
    message_enabled: true,
    open_chat_enabled: true,
    request_enabled: true,
    preview_enabled: true,
    sound_enabled: true,
    vibration_enabled: true,
  },
  loadNotificationPreferences: () => mockLoad(),
  saveNotificationPreferences: (preferences: unknown) => mockSave(preferences),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockLoad.mockResolvedValue({
    message_enabled: true,
    open_chat_enabled: true,
    request_enabled: true,
    preview_enabled: true,
    sound_enabled: true,
    vibration_enabled: true,
  })
  mockSave.mockResolvedValue(undefined)
})

test('shows and persists the separate open-chat notification switch', async () => {
  render(<NotificationSettings visible onClose={jest.fn()} />)
  const openChatSwitch = await screen.findByLabelText('수다방 알림')
  expect(openChatSwitch.props.value).toBe(true)

  fireEvent(openChatSwitch, 'valueChange', false)
  await waitFor(() => expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
    message_enabled: true,
    open_chat_enabled: false,
  })))
  expect(screen.getByLabelText('수다방 알림').props.value).toBe(false)
})

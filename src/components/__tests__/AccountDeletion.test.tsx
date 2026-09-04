import { fireEvent, render, screen } from '@testing-library/react-native'
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { AccountDeletion } from '../AccountDeletion'

const mockDeleteAccount = jest.fn()
jest.mock('../../i18n', () => ({ useI18n: () => ({ language: 'ko' }) }))
jest.mock('../../lib/supabase', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: {} } }) },
  functions: { invoke: (...args: unknown[]) => mockDeleteAccount(...args) },
} }))
jest.mock('../../lib/observability', () => ({ captureAppError: jest.fn(), identifyAnonymousUser: jest.fn() }))
jest.mock('../SwipeDismissView', () => ({ SwipeDismissView: ({ children }: any) => children }))

const originalPlatform = Platform.OS
afterEach(() => {
  jest.restoreAllMocks()
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
})

test.each(['ios', 'android'] as const)('uses native scroll visibility without manual focus scrolling on %s', platform => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform })
  render(<AccountDeletion onDeleted={jest.fn()} />)
  fireEvent.press(screen.getByRole('button', { name: '탈퇴' }))
  const scroll = screen.UNSAFE_getByType(ScrollView)
  const viewport = screen.UNSAFE_getByType(KeyboardAvoidingView)
  expect(viewport.props.enabled).toBe(true)
  expect(viewport.props.behavior).toBe('padding')
  expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(platform === 'ios')
  expect(scroll.props.onLayout).toBeUndefined()
  expect(screen.getByPlaceholderText('탈퇴합니다').props.onFocus).toBeUndefined()
  expect(mockDeleteAccount).not.toHaveBeenCalled()
})

test('typing and keyboard Done never delete the account, and cancel clears confirmation', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {})
  const onDeleted = jest.fn()
  render(<AccountDeletion onDeleted={onDeleted} />)
  fireEvent.press(screen.getByRole('button', { name: '탈퇴' }))
  const input = screen.getByPlaceholderText('탈퇴합니다')
  const button = screen.getByText('계정과 데이터 영구 삭제')
  expect(button).toBeDisabled()
  fireEvent.changeText(input, '탈퇴')
  expect(button).toBeDisabled()
  fireEvent.changeText(input, '탈퇴합니다')
  expect(button).not.toBeDisabled()
  fireEvent(input, 'submitEditing')
  expect(dismiss).toHaveBeenCalledTimes(1)
  expect(mockDeleteAccount).not.toHaveBeenCalled()
  expect(onDeleted).not.toHaveBeenCalled()

  fireEvent.press(screen.getByText('취소'))
  fireEvent.press(screen.getByRole('button', { name: '탈퇴' }))
  expect(screen.getByPlaceholderText('탈퇴합니다').props.value).toBe('')
  expect(screen.getByText('계정과 데이터 영구 삭제')).toBeDisabled()
})

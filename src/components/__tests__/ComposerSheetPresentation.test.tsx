import { fireEvent, render } from '@testing-library/react-native'
import { KeyboardAvoidingView, Modal, Platform } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { TalkWriteSheet } from '../../../App'
import { Board } from '../Board'

jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: false,
  supabase: null,
}))
jest.mock('../BoardBannerAd', () => ({ BoardBannerAd: () => null }))
jest.mock('../OpenChatAudio', () => {
  const { View } = jest.requireActual('react-native')
  return {
    OpenChatAudioMessage: () => <View />,
    OpenChatVoiceRecorder: () => <View />,
  }
})

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
}

const originalPlatform = Platform.OS
beforeAll(() => Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' }))
afterAll(() => Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform }))

test('talk writer uses the same sliding page-sheet presentation as room creation', () => {
  const screen = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <TalkWriteSheet
        visible
        guestProfile={{ nickname: '테스터', age: 30, gender: 'male' }}
        onClose={jest.fn()}
      />
    </SafeAreaProvider>,
  )

  const modal = screen.UNSAFE_getByType(Modal)
  expect(modal.props.animationType).toBe('slide')
  expect(modal.props.presentationStyle).toBe('pageSheet')
  expect(screen.getByText('대화 카드 만들기')).toBeTruthy()
  expect(screen.getByText('취소')).toBeTruthy()
  expect(screen.getByText('대화 카드 등록')).toBeTruthy()

  const viewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'talk-write-keyboard-viewport')
  expect(viewport?.props.enabled).toBe(true)
  expect(viewport?.props.behavior).toBe('padding')
})

test('board writer opens as a sliding page sheet with fixed bottom actions', () => {
  const onComposerVisibilityChange = jest.fn()
  const screen = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <Board onComposerVisibilityChange={onComposerVisibilityChange} />
    </SafeAreaProvider>,
  )

  fireEvent.press(screen.getByRole('button', { name: '글쓰기' }))

  const modal = screen.getByTestId('board-write-modal')
  expect(modal.props.animationType).toBe('slide')
  expect(modal.props.presentationStyle).toBe('pageSheet')
  expect(screen.getByText('익명 글쓰기')).toBeTruthy()
  expect(screen.getByText('익명으로 편하게 나눌 이야기를 작성해 주세요.')).toBeTruthy()
  expect(screen.getByText('취소')).toBeTruthy()
  expect(screen.getByText('등록')).toBeTruthy()
  expect(onComposerVisibilityChange).toHaveBeenCalledWith(true)
  const viewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'board-write-keyboard-viewport')
  expect(viewport?.props.enabled).toBe(true)
  expect(viewport?.props.behavior).toBe('padding')

  const form = screen.getByTestId('board-write-form')
  const orderedFields = form.findAll(node =>
    node.props.testID === 'board-write-photo-field' || node.props.testID === 'board-write-title-input',
  )
  expect([...new Set(orderedFields.map(node => node.props.testID))]).toEqual([
    'board-write-photo-field',
    'board-write-title-input',
  ])
  expect(screen.getByTestId('board-write-title-input').props.returnKeyType).toBe('next')
  expect(typeof screen.getByTestId('board-write-title-input').props.onSubmitEditing).toBe('function')
  expect(screen.getByTestId('board-write-body-input')).toBeTruthy()
})

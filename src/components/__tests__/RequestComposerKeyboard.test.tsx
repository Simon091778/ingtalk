import { act, fireEvent, render } from '@testing-library/react-native'
import { AccessibilityInfo, Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, StyleSheet, type KeyboardEvent } from 'react-native'
import * as Reanimated from 'react-native-reanimated'
import { RequestComposer } from '../ChatFlow'
import { supabase } from '../../lib/supabase'
import type { TalkCard } from '../../types'

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default)
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native')
  const gesture = new Proxy({}, { get: () => () => gesture })
  return { Gesture: { Pan: () => gesture, Pinch: () => gesture, Tap: () => gesture, Race: () => gesture, Simultaneous: () => gesture }, GestureDetector: View, GestureHandlerRootView: View }
})
jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn() } }))
jest.mock('../../lib/observability', () => ({ addAppBreadcrumb: jest.fn(), captureAppError: jest.fn() }))
jest.mock('../../i18n/localizedUi', () => {
  const { Text, TextInput } = require('react-native')
  return { Text, TextInput }
})

const originalPlatform = Platform.OS
const listeners = new Map<string, Set<(event: KeyboardEvent) => void>>()
const card: TalkCard = {
  id: 'test-card', authorId: 'other-user', nickname: '상대방', ageRange: '30대', region: '서울',
  purpose: '대화', topic: '편하게 이야기해요', trustLabel: '', minutesAgo: 0,
}
const eventAt = (screenY: number, height = 800 - screenY): KeyboardEvent => ({
  duration: 0, easing: 'keyboard', endCoordinates: { screenX: 0, screenY, width: 400, height },
})

beforeEach(() => {
  jest.useFakeTimers()
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  listeners.clear()
  jest.mocked(supabase!.rpc).mockReset()
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
    const callbacks = listeners.get(name) ?? new Set()
    callbacks.add(listener)
    listeners.set(name, callbacks)
    return { remove: () => { callbacks.delete(listener) } } as ReturnType<typeof Keyboard.addListener>
  })
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
})

async function showComposer() {
  const screen = render(<RequestComposer card={card} onClose={jest.fn()} />)
  await act(async () => {})
  const layout = async (height: number) => {
    await act(async () => {
      fireEvent(screen.getByTestId('request-keyboard-viewport'), 'layout', {
        persist: () => {}, nativeEvent: { layout: { x: 0, y: 0, width: 400, height } },
      })
    })
  }
  const emit = async (name: string, event: KeyboardEvent) => {
    await act(async () => { listeners.get(name)?.forEach(callback => callback(event)) })
  }
  const padding = () => StyleSheet.flatten(screen.getByTestId('request-keyboard-viewport').props.style).paddingBottom
  return { screen, layout, emit, padding }
}

it('keeps the expanded card lower placement with 16dp keyboard clearance when the modal does not resize', async () => {
  const { screen, layout, emit, padding } = await showComposer()
  await layout(800)
  await emit('keyboardDidShow', eventAt(500))
  expect(padding()).toBe(300)
  const gap = StyleSheet.flatten(screen.getByTestId('request-overlay').props.style).paddingBottom
  expect(gap).toBe(16)
  const overlay = StyleSheet.flatten(screen.getByTestId('request-overlay').props.style)
  const dialog = StyleSheet.flatten(screen.getByTestId('request-dialog').props.style)
  expect(overlay.justifyContent).toBe('flex-end')
  expect(overlay.paddingTop).toBe(16)
  // Bottom alignment restores the pre-optimization position, not the safe-area top.
  const available = 800 - padding() - overlay.paddingTop - gap
  const cardBottom = 800 - padding() - gap
  const cardTop = cardBottom - Math.min(dialog.height, available * 0.92)
  expect(cardTop).toBe(67)
  expect(500 - cardBottom).toBe(16)
  expect(screen.getByPlaceholderText('예: 저도 전시를 좋아해요. 편하게 이야기해 볼까요?')).toBeTruthy()
  expect(screen.getByText('대화 요청하기 · 100P')).toBeTruthy()
})

it('starts only the Android card fade immediately without a shade or keyboard wait', async () => {
  const timing = jest.spyOn(Reanimated, 'withTiming')
  const { screen, emit } = await showComposer()
  timing.mockClear()
  const timersBeforeShow = jest.getTimerCount()
  act(() => screen.UNSAFE_getByType(Modal).props.onShow())
  expect(timing.mock.calls).toEqual([[1, { duration: 160 }]])
  expect(screen.queryByTestId('request-shade')).toBeNull()
  // No input layout yet: neither an early focus request nor a card-show timer.
  expect(jest.getTimerCount()).toBe(timersBeforeShow)
  act(() => jest.advanceTimersByTime(1500))
  await emit('keyboardDidShow', eventAt(500))
  expect(timing).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('request-shade')).toBeNull()
})

it('keeps a transparent full-screen modal and outside-tap dismissal on Android', async () => {
  const onClose = jest.fn()
  const screen = render(<RequestComposer card={card} onClose={onClose} />)
  await act(async () => {})
  const modal = screen.UNSAFE_getByType(Modal)
  expect(modal.props.transparent).toBe(true)
  expect(modal.props.animationType).toBe('none')
  const outside = screen.getByLabelText('대화 신청 창 닫기')
  const outsideStyle = StyleSheet.flatten(outside.props.style)
  expect(outsideStyle).toMatchObject(StyleSheet.absoluteFillObject)
  expect(outsideStyle.backgroundColor).toBeUndefined()
  fireEvent.press(outside)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('uses no entrance animation on Android with reduced motion enabled', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
  const timing = jest.spyOn(Reanimated, 'withTiming')
  const { screen } = await showComposer()
  timing.mockClear()
  act(() => screen.UNSAFE_getByType(Modal).props.onShow())
  expect(timing.mock.calls).toEqual([[1, { duration: 0 }]])
  expect(screen.queryByTestId('request-shade')).toBeNull()
})

it('keeps the restored Android bottom alignment and clearance across keyboard size changes', async () => {
  const { screen, layout, emit, padding } = await showComposer()
  await layout(800)
  const initial = StyleSheet.flatten(screen.getByTestId('request-overlay').props.style)
  for (const keyboardTop of [500, 360, 600]) {
    await emit('keyboardDidShow', eventAt(keyboardTop))
    const current = StyleSheet.flatten(screen.getByTestId('request-overlay').props.style)
    expect(current.paddingTop).toBe(initial.paddingTop)
    expect(current.justifyContent).toBe('flex-end')
    expect(keyboardTop - (800 - padding() - current.paddingBottom)).toBe(16)
  }
  await emit('keyboardDidHide', eventAt(800, 0))
  expect(StyleSheet.flatten(screen.getByTestId('request-overlay').props.style).paddingTop).toBe(initial.paddingTop)
  expect(padding()).toBe(0)
})

it('does not subtract the keyboard twice when native adjustResize already resized the modal', async () => {
  const { layout, emit, padding } = await showComposer()
  await layout(500)
  await emit('keyboardDidShow', eventAt(500))
  expect(padding()).toBe(0)
})

it('recalculates the remaining overlap when the modal resize arrives after the keyboard event', async () => {
  const { layout, emit, padding } = await showComposer()
  await layout(800)
  await emit('keyboardDidShow', eventAt(500))
  expect(padding()).toBe(300)
  await layout(550)
  expect(padding()).toBe(50)
  await layout(500)
  expect(padding()).toBe(0)
})

it('handles different keyboard sizes and repeated hide/show without accumulating offsets', async () => {
  const { layout, emit, padding } = await showComposer()
  await layout(800)
  for (const keyboardTop of [500, 420, 600, 500]) {
    await emit('keyboardDidShow', eventAt(keyboardTop))
    expect(padding()).toBe(800 - keyboardTop)
    await emit('keyboardDidHide', eventAt(800, 0))
    expect(padding()).toBe(0)
  }
})

it('does not move or scale the Android card down towards the IME during entry', async () => {
  const { screen } = await showComposer()
  const style = StyleSheet.flatten(screen.getByTestId('request-dialog').props.style)
  expect(style.transform).toContainEqual({ translateY: 0 })
  expect(style.transform).toContainEqual({ scale: 1 })
  // A tall keyboard must be allowed to shrink the scrolling form instead of
  // pushing the fixed footer outside the card's maxHeight.
  expect(StyleSheet.flatten(screen.getByTestId('request-form-scroll').props.style).minHeight).toBe(0)
})

it('starts with a fresh keyboard offset each time the request modal is reopened', async () => {
  const { screen, layout, emit, padding } = await showComposer()
  for (let index = 0; index < 5; index += 1) {
    await layout(800)
    await emit('keyboardDidShow', eventAt(500))
    expect(padding()).toBe(300)
    screen.rerender(<RequestComposer card={null} onClose={jest.fn()} />)
    screen.rerender(<RequestComposer card={{ ...card, id: `card-${index}` }} onClose={jest.fn()} />)
    await act(async () => {})
    expect(padding()).toBe(0)
  }
  screen.unmount()
  expect([...listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true)
})

it('preserves iPhone padding and centering with the expanded card offset', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  const { screen, layout, emit, padding } = await showComposer()
  const timing = jest.spyOn(Reanimated, 'withTiming')
  act(() => screen.UNSAFE_getByType(Modal).props.onShow())
  expect(timing.mock.calls).toEqual([[1, { duration: 200 }], [1, { duration: 200 }]])
  expect(screen.getByTestId('request-shade')).toBeTruthy()
  expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe('padding')
  expect(StyleSheet.flatten(screen.getByTestId('request-overlay').props.style).justifyContent).toBe('center')
  expect(StyleSheet.flatten(screen.getByTestId('request-dialog').props.style).top).toBe(24.5)
  expect(StyleSheet.flatten(screen.getByTestId('request-form-scroll').props.style).minHeight).toBe(168)
  await layout(800)
  await emit('keyboardWillShow', eventAt(500))
  expect(padding()).toBe(300)
  await emit('keyboardWillHide', eventAt(800, 0))
  expect(padding()).toBe(0)
})

it.each(['android', 'ios'] as const)('expands the card up 5dp and down 2dp on %s when space permits', async platform => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform })
  const { screen } = await showComposer()
  const overlay = StyleSheet.flatten(screen.getByTestId('request-overlay').props.style)
  const dialog = StyleSheet.flatten(screen.getByTestId('request-dialog').props.style)
  const viewportHeight = 600
  const oldHeight = 410
  const oldTop = platform === 'android'
    ? viewportHeight - 18 - oldHeight
    : overlay.paddingTop + (viewportHeight - overlay.paddingTop - overlay.paddingBottom - oldHeight) / 2 + 26
  const newTop = platform === 'android'
    ? viewportHeight - overlay.paddingBottom - dialog.height
    : overlay.paddingTop + (viewportHeight - overlay.paddingTop - overlay.paddingBottom - dialog.height) / 2 + dialog.top
  expect(dialog.height).toBe(417)
  expect(newTop - oldTop).toBe(-5)
  expect(newTop + dialog.height - (oldTop + oldHeight)).toBe(2)
  // Keep the existing small-screen safety cap rather than forcing a taller card.
  expect(dialog.maxHeight).toBe('92%')
})

it.each(['android', 'ios'] as const)('closes after success and supports the next request without a navigation callback on %s', async platform => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: platform })
  const rpc = jest.mocked(supabase!.rpc)
  rpc.mockResolvedValue({ data: null, error: null } as never)
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const onClose = jest.fn()
  const firstCard = { ...card, id: '00000000-0000-4000-8000-000000000001' }
  const secondCard = { ...card, id: '00000000-0000-4000-8000-000000000002', nickname: '다른 이용자' }
  const screen = render(<RequestComposer card={firstCard} onClose={onClose} />)
  await act(async () => {})
  fireEvent.changeText(screen.getByPlaceholderText('예: 저도 전시를 좋아해요. 편하게 이야기해 볼까요?'), '안녕하세요!')
  await act(async () => { fireEvent.press(screen.getByText('대화 요청하기 · 100P')) })
  expect(rpc).toHaveBeenNthCalledWith(1, 'create_chat_request', { card_uuid: firstCard.id, opening_text: '안녕하세요!' })
  expect(alert).not.toHaveBeenCalled()
  expect(screen.getByTestId('request-sent-toast')).toBeTruthy()
  expect(onClose).toHaveBeenCalledTimes(1)

  // The parent clears only the selected card, then the next Discovery card opens
  // the same composer. Preserve the last greeting for consecutive requests.
  screen.rerender(<RequestComposer card={null} onClose={onClose} />)
  expect(screen.UNSAFE_getByType(Modal).props.visible).toBe(false)
  screen.rerender(<RequestComposer card={secondCard} onClose={onClose} />)
  await act(async () => {})
  expect(screen.getByDisplayValue('안녕하세요!')).toBeTruthy()
  await act(async () => { fireEvent.press(screen.getByText('대화 요청하기 · 100P')) })
  expect(rpc).toHaveBeenNthCalledWith(2, 'create_chat_request', { card_uuid: secondCard.id, opening_text: '안녕하세요!' })
  expect(onClose).toHaveBeenCalledTimes(2)
})

it('keeps the composer and message open when the server rejects a request', async () => {
  jest.mocked(supabase!.rpc).mockResolvedValue({ data: null, error: { message: 'insufficient_points' } } as never)
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const onClose = jest.fn()
  const screen = render(<RequestComposer card={{ ...card, id: '00000000-0000-4000-8000-000000000001' }} onClose={onClose} />)
  await act(async () => {})
  fireEvent.changeText(screen.getByPlaceholderText('예: 저도 전시를 좋아해요. 편하게 이야기해 볼까요?'), '안녕하세요!')
  await act(async () => { fireEvent.press(screen.getByText('대화 요청하기 · 100P')) })
  expect(onClose).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('신청하지 못했어요', expect.any(String))
  expect(screen.getByDisplayValue('안녕하세요!')).toBeTruthy()
  expect(screen.getByText('대화 요청하기 · 100P')).toBeTruthy()
})

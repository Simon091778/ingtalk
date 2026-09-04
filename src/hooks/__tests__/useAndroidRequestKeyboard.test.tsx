import { act, renderHook } from '@testing-library/react-native'
import { AppState, Keyboard, Platform, UIManager, type AppStateStatus, type KeyboardEvent, type LayoutChangeEvent, type TextInput } from 'react-native'
import { useAndroidRequestKeyboard } from '../useAndroidRequestKeyboard'

jest.mock('../../lib/observability', () => ({ addAppBreadcrumb: jest.fn() }))

const originalPlatform = Platform.OS
const originalAppState = AppState.currentState
const listeners = new Map<string, () => void>()
let appStateChange: (state: AppStateStatus) => void
let frames: Map<number, FrameRequestCallback>
let frameId: number
const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 104 } } } as LayoutChangeEvent

beforeEach(() => {
  jest.useFakeTimers()
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' })
  frames = new Map()
  frameId = 0
  listeners.clear()
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
    listeners.set(event, () => callback({} as KeyboardEvent))
    return { remove: () => { listeners.delete(event) } } as ReturnType<typeof Keyboard.addListener>
  })
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, callback) => {
    if (event === 'change') appStateChange = callback
    return { remove: jest.fn() }
  })
  jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(42)
  jest.spyOn(UIManager, 'dispatchViewManagerCommand').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: originalAppState })
})

function setup() {
  let focused = false
  const focus = jest.fn(() => { focused = true })
  const blur = jest.fn(() => { focused = false })
  const inputRef = { current: { focus, blur, isFocused: () => focused } as unknown as TextInput }
  const hook = renderHook(({ id }: { id: string | undefined }) => useAndroidRequestKeyboard(id, inputRef), {
    initialProps: { id: 'card-a' as string | undefined },
  })
  const ready = () => act(() => {
    hook.result.current.onModalShow()
    hook.result.current.onInputLayout(layout)
  })
  const nextFrame = () => act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(16))
  })
  return { ...hook, focus, blur, inputRef, ready, nextFrame }
}

it.each(['show-first', 'layout-first'])('waits for both native show and input layout, then yields one frame (%s)', order => {
  const { result, focus, nextFrame } = setup()
  act(() => {
    if (order === 'show-first') result.current.onModalShow()
    else result.current.onInputLayout(layout)
  })
  expect(frames.size).toBe(0)
  act(() => {
    if (order === 'show-first') result.current.onInputLayout(layout)
    else result.current.onModalShow()
  })
  expect(focus).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  nextFrame()
  expect(focus).toHaveBeenCalledTimes(1)
})

it('retries an already-focused input using native focus without hiding the pending IME', () => {
  const { focus, blur, ready, nextFrame } = setup()
  ready()
  nextFrame()
  act(() => jest.advanceTimersByTime(300))
  expect(focus).toHaveBeenCalledTimes(1)
  expect(blur).not.toHaveBeenCalled()
  expect(UIManager.dispatchViewManagerCommand).toHaveBeenCalledWith(42, 'focus', [])
  act(() => jest.advanceTimersByTime(2000))
  expect(UIManager.dispatchViewManagerCommand).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})

it.each(['keyboardDidShow', 'keyboardDidHide'])('stops retries on %s', event => {
  const { ready, nextFrame } = setup()
  ready()
  nextFrame()
  act(() => listeners.get(event)?.())
  act(() => jest.advanceTimersByTime(5000))
  expect(UIManager.dispatchViewManagerCommand).not.toHaveBeenCalled()
})

it.each(['keyboardDidShow', 'keyboardDidHide'])('ignores a previous modal %s event before the new input is ready', event => {
  const { ready, nextFrame, focus } = setup()
  act(() => listeners.get(event)?.())
  ready()
  act(() => listeners.get(event)?.())
  nextFrame()
  expect(focus).toHaveBeenCalledTimes(1)
})

it('stops retries when the keyboard is visible even if our listener is delayed', () => {
  const { ready, nextFrame } = setup()
  ready()
  nextFrame()
  jest.mocked(Keyboard.isVisible).mockReturnValue(true)
  act(() => jest.advanceTimersByTime(5000))
  expect(UIManager.dispatchViewManagerCommand).not.toHaveBeenCalled()
})

it('does not let an old frame focus a reopened modal and ignores duplicate layout/show events', () => {
  const { ready, nextFrame, rerender, focus } = setup()
  ready()
  const staleFrame = [...frames.values()][0]!
  rerender({ id: undefined })
  rerender({ id: 'card-b' })
  ready()
  act(() => staleFrame(16))
  expect(focus).not.toHaveBeenCalled()
  ready()
  expect(frames.size).toBe(1)
  nextFrame()
  expect(focus).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'close', 'unmount', 'background'])('cancels pending retries on %s', reason => {
  const { ready, nextFrame, rerender, unmount, result } = setup()
  ready()
  nextFrame()
  if (reason === 'cancel') act(() => result.current.cancel())
  if (reason === 'close') rerender({ id: undefined })
  if (reason === 'unmount') unmount()
  if (reason === 'background') act(() => appStateChange('background'))
  act(() => jest.advanceTimersByTime(5000))
  expect(UIManager.dispatchViewManagerCommand).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})

it('survives a detached native input without blurring or crashing', () => {
  const { ready, nextFrame, blur } = setup()
  ready()
  nextFrame()
  jest.mocked(UIManager.dispatchViewManagerCommand).mockImplementation(() => { throw new Error('detached') })
  expect(() => act(() => jest.advanceTimersByTime(5000))).not.toThrow()
  expect(UIManager.dispatchViewManagerCommand).toHaveBeenCalledTimes(3)
  expect(blur).not.toHaveBeenCalled()
})

it('does not take over iPhone focus or subscribe to Android events', () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  const { ready, nextFrame, focus } = setup()
  ready()
  nextFrame()
  act(() => jest.advanceTimersByTime(5000))
  expect(focus).not.toHaveBeenCalled()
  expect(Keyboard.addListener).not.toHaveBeenCalled()
  expect(UIManager.dispatchViewManagerCommand).not.toHaveBeenCalled()
})

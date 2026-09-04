import { act, render } from '@testing-library/react-native'
import { Dimensions, Platform, Text, View } from 'react-native'
import { SwipeDismissView } from '../SwipeDismissView'

const mockGestures: any[] = []
const mockTiming = jest.fn((value: number, _options?: unknown, complete?: (finished: boolean) => void) => {
  complete?.(true)
  return value
})
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (style: () => unknown) => style(),
  withTiming: (...args: Parameters<typeof mockTiming>) => mockTiming(...args),
  runOnJS: (callback: (...args: any[]) => unknown) => callback,
}))
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native')
  return {
    GestureHandlerRootView: View, GestureDetector: View,
    Gesture: {
      Pan: () => {
        const config: Record<string, any> = {}
        const gesture: any = new Proxy({}, { get: (_, key: string) => (...args: any[]) => {
          config[key] = args.length === 1 ? args[0] : args
          return gesture
        } })
        mockGestures.push(config)
        return gesture
      },
      Native: () => ({}),
      Simultaneous: (pan: unknown) => pan,
    },
  }
})
const originalPlatform = Platform.OS
beforeEach(() => { mockGestures.length = 0; mockTiming.mockClear() })
afterEach(() => { jest.restoreAllMocks(); Object.assign(Platform, { OS: originalPlatform }) })

test.each(['ios', 'android'])('%s settings enter horizontally from the right on every opening', platform => {
  Object.assign(Platform, { OS: platform })
  let nextFrame!: FrameRequestCallback
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { nextFrame = callback; return 1 })
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  const dismiss = jest.fn()
  const panel = (visible: boolean) => <SwipeDismissView visible={visible} enterFromRight onDismiss={dismiss}><Text>Settings</Text></SwipeDismissView>
  const view = render(panel(false))
  const animatedPanel = () => view.UNSAFE_getAllByType(View).find(node => Array.isArray(node.props.style))!
  expect(animatedPanel().props.style[1].transform).toEqual([{ translateX: Dimensions.get('window').width }])
  expect(mockTiming).not.toHaveBeenCalled()
  view.rerender(panel(true))
  act(() => nextFrame(0))
  expect(mockTiming).toHaveBeenLastCalledWith(0, { duration: 210 })
  view.rerender(panel(false))
  mockTiming.mockClear()
  view.rerender(panel(true))
  act(() => nextFrame(0))
  expect(mockTiming).toHaveBeenCalledTimes(1)
  expect(mockTiming).toHaveBeenLastCalledWith(0, { duration: 210 })
  expect(dismiss).not.toHaveBeenCalled()
})

test.each(['ios', 'android'])('%s auth swipe starts at the left edge without an entry animation', platform => {
  Object.assign(Platform, { OS: platform })
  const dismiss = jest.fn()
  render(<SwipeDismissView onDismiss={dismiss} enterFromRight={false} edgeWidth={24}><Text>Form</Text></SwipeDismissView>)
  const gesture = mockGestures[0]
  expect(gesture.hitSlop).toEqual({ left: 0, width: 24 })
  expect(gesture.failOffsetY).toEqual([-24, 24])
  expect(mockTiming).not.toHaveBeenCalled()
  act(() => gesture.onEnd({ translationX: 100, velocityX: 0 }, true))
  expect(dismiss).toHaveBeenCalledTimes(1)
})

test.each([
  { distance: 30, velocity: 0, success: true, enabled: true },
  { distance: -100, velocity: 900, success: true, enabled: true },
  { distance: 120, velocity: 900, success: false, enabled: true },
  { distance: 120, velocity: 900, success: true, enabled: false },
])('short, reversed, cancelled or disabled swipes return to the form (%j)', ({ distance, velocity, success, enabled }) => {
  const dismiss = jest.fn()
  render(<SwipeDismissView onDismiss={dismiss} enterFromRight={false} enabled={enabled}><Text>Form</Text></SwipeDismissView>)
  act(() => mockGestures[0].onEnd({ translationX: distance, velocityX: velocity }, success))
  expect(dismiss).not.toHaveBeenCalled()
  expect(mockTiming).toHaveBeenLastCalledWith(0, { duration: 180 })
})

test('a cancelled long drag resets instead of leaving the screen shifted', () => {
  render(<SwipeDismissView onDismiss={jest.fn()} enterFromRight={false}><Text>Form</Text></SwipeDismissView>)
  act(() => {
    mockGestures[0].onUpdate({ translationX: 140 })
    mockGestures[0].onFinalize()
  })
  expect(mockTiming).toHaveBeenLastCalledWith(0, { duration: 180 })
})

import { render } from '@testing-library/react-native'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChatRoomSafeArea } from '../ChatRoomSafeArea'

const originalPlatform = Platform.OS
const insets = { top: 24, bottom: 48, left: 0, right: 0 }
const style = { flex: 1, backgroundColor: '#FFFCFD' }

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
})

describe('ChatRoomSafeArea', () => {
  it.each([false, true])('Android uses native modal safe-area edges without app-root padding (keyboard: %s)', keyboardVisible => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
    const screen = render(
      <ChatRoomSafeArea insets={insets} keyboardVisible={keyboardVisible} style={style}>
        <Text>composer</Text>
      </ChatRoomSafeArea>,
    )

    const safeArea = screen.UNSAFE_getByType(SafeAreaView)
    expect(safeArea.props.edges).toEqual(['top', 'bottom'])
    expect(StyleSheet.flatten(safeArea.props.style)).toEqual(style)
    expect(screen.getByText('composer')).toBeTruthy()

    // Root-window inset updates must not add padding to the Android modal.
    screen.rerender(
      <ChatRoomSafeArea insets={{ ...insets, bottom: 24 }} keyboardVisible={keyboardVisible} style={style} />,
    )
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(SafeAreaView).props.style)).toEqual(style)
  })

  it('iOS keeps the plain View and restores its bottom inset after the keyboard closes', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    const screen = render(<ChatRoomSafeArea insets={insets} keyboardVisible={false} style={style} />)

    expect(screen.UNSAFE_queryByType(SafeAreaView)).toBeNull()
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(View).props.style)).toEqual({
      ...style, paddingTop: 24, paddingBottom: 48,
    })

    screen.rerender(<ChatRoomSafeArea insets={insets} keyboardVisible style={style} />)
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(View).props.style)).toEqual({
      ...style, paddingTop: 24, paddingBottom: 0,
    })

    screen.rerender(<ChatRoomSafeArea insets={insets} keyboardVisible={false} style={style} />)
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(View).props.style)).toEqual({
      ...style, paddingTop: 24, paddingBottom: 48,
    })
  })
})

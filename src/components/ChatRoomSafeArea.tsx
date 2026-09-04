import { Platform, View, type ViewProps } from 'react-native'
import { SafeAreaView, type EdgeInsets } from 'react-native-safe-area-context'

type ChatRoomSafeAreaProps = ViewProps & {
  insets: EdgeInsets
  keyboardVisible: boolean
}

export function ChatRoomSafeArea({ insets, keyboardVisible, style, ...props }: ChatRoomSafeAreaProps) {
  if (Platform.OS === 'android') {
    // Match SupportCenter: measure this modal's native safe area instead of
    // adding the app-root insets to a window that may already exclude system bars.
    return <SafeAreaView {...props} edges={['top', 'bottom']} style={style} />
  }

  // Preserve the existing iOS layout and keyboard/home-indicator handling.
  return <View {...props} style={[
    style,
    { paddingTop: insets.top, paddingBottom: keyboardVisible ? 0 : insets.bottom },
  ]} />
}

import type { PropsWithChildren } from 'react'
import { Dimensions, Keyboard, Platform, StyleSheet } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

type SwipeDismissViewProps = PropsWithChildren<{
  onDismiss: () => void
  onDismissStart?: () => void
  enabled?: boolean
}>

export function SwipeDismissView({ children, onDismiss, onDismissStart, enabled = true }: SwipeDismissViewProps) {
  const translateX = useSharedValue(0)
  const dismissing = useSharedValue(false)
  const screenWidth = Dimensions.get('window').width

  const finishDismiss = () => {
    Keyboard.dismiss()
    onDismiss()
    requestAnimationFrame(() => {
      translateX.value = 0
      dismissing.value = false
    })
  }

  const swipeGesture = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX(18)
    .failOffsetY([-24, 24])
    .onUpdate(event => {
      if (event.translationX > 0) translateX.value = event.translationX
    })
    .onEnd(event => {
      if (event.translationX > 90 || event.velocityX > 700) {
        dismissing.value = true
        if (onDismissStart) runOnJS(onDismissStart)()
        translateX.value = withTiming(screenWidth + 40, { duration: 210 }, finished => {
          if (finished) runOnJS(finishDismiss)()
        })
      } else translateX.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!dismissing.value && translateX.value > 0 && translateX.value <= 90) {
        translateX.value = withTiming(0, { duration: 180 })
      }
    })

  // ScrollView and Switch install native gestures of their own. Recognize those
  // simultaneously so a horizontal back swipe is not swallowed by vertical
  // scrolling or controls inside a settings screen.
  const gesture = Platform.OS === 'ios'
    ? Gesture.Simultaneous(swipeGesture, Gesture.Native())
    : swipeGesture

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }))

  return <GestureHandlerRootView style={styles.flex}>
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.flex, animatedStyle]}>{children}</Animated.View>
    </GestureDetector>
  </GestureHandlerRootView>
}

const styles = StyleSheet.create({ flex: { flex: 1 } })

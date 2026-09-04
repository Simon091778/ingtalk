import { useEffect, useState } from 'react'
import { Keyboard, Platform, useWindowDimensions } from 'react-native'

export function useIosKeyboardInset(enabled: boolean) {
  const { height: windowHeight } = useWindowDimensions()
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (Platform.OS !== 'ios' || !enabled) {
      setInset(0)
      return
    }

    const frameSubscription = Keyboard.addListener('keyboardWillChangeFrame', event => {
      setInset(Math.max(0, windowHeight - event.endCoordinates.screenY))
    })
    const hideSubscription = Keyboard.addListener('keyboardWillHide', () => setInset(0))

    return () => {
      frameSubscription.remove()
      hideSubscription.remove()
    }
  }, [enabled, windowHeight])

  return inset
}

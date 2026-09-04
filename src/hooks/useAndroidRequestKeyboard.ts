import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { AppState, findNodeHandle, Keyboard, Platform, UIManager, type LayoutChangeEvent, type TextInput } from 'react-native'
import { addAppBreadcrumb } from '../lib/observability'

// Re-request the IME without blurring: blur also sends hideSoftInputFromWindow
// and can interrupt a keyboard that is already opening. RN's public focus()
// is a JS no-op for an already-focused input, so that case needs the native
// AndroidTextInput focus command (supported by both Paper and Fabric in RN 0.81).
function requestKeyboard(input: TextInput | null) {
  if (!input) return
  try {
    if (!input.isFocused()) input.focus()
    else {
      const tag = findNodeHandle(input)
      if (tag !== null) UIManager.dispatchViewManagerCommand(tag, 'focus', [])
    }
  } catch {
    // The view may have detached between the layout event and this frame.
    // Keep the visible input usable; never fail opening the request card.
    addAppBreadcrumb('request_keyboard_focus_unavailable', { platform: 'android' })
  }
}

export function useAndroidRequestKeyboard(requestId: string | undefined, inputRef: RefObject<TextInput | null>) {
  const active = Platform.OS === 'android' && requestId !== undefined
  const activeRef = useRef(active)
  activeRef.current = active
  const shown = useRef(false)
  const laidOut = useRef(false)
  const started = useRef(false)
  const focusRequested = useRef(false)
  const allowed = useRef(false)
  const generation = useRef(0)
  const frame = useRef<number | null>(null)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const cancel = useCallback(() => {
    allowed.current = false
    generation.current += 1
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  useLayoutEffect(() => {
    cancel()
    shown.current = false
    laidOut.current = false
    started.current = false
    focusRequested.current = false
    allowed.current = active
    return cancel
  }, [active, requestId, cancel])

  const startIfReady = useCallback(() => {
    if (!activeRef.current || !allowed.current || !shown.current || !laidOut.current || started.current) return
    started.current = true
    const session = generation.current
    const canRequest = () => activeRef.current && allowed.current && generation.current === session &&
      (AppState.currentState === 'active' || AppState.currentState === null)
    // onShow alone doesn't guarantee that the editor is attached. Wait for
    // its layout too, then yield a frame for the modal window focus handoff.
    frame.current = requestAnimationFrame(() => {
      if (!canRequest()) return
      frame.current = null
      focusRequested.current = true
      requestKeyboard(inputRef.current)
      if (!canRequest() || Keyboard.isVisible()) return
      timers.current = [250, 650, 1200].map(delay => setTimeout(() => {
        if (!canRequest()) return
        if (Keyboard.isVisible()) { cancel(); return }
        requestKeyboard(inputRef.current)
      }, delay))
    })
  }, [cancel, inputRef])

  useEffect(() => {
    if (!active) return
    // A previous modal's hide/show event can arrive while this editor is still
    // mounting. It must not cancel the new session before its first focus.
    const stopStartedRequest = () => { if (focusRequested.current) cancel() }
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', stopStartedRequest),
      // Respect Back/dismiss and never reopen the keyboard after user dismissal.
      Keyboard.addListener('keyboardDidHide', stopStartedRequest),
      // Do not cancel on AppState "blur": opening the native Modal can itself
      // take focus away from the activity without backgrounding the app.
      AppState.addEventListener('change', state => { if (state !== 'active') cancel() }),
    ]
    return () => subscriptions.forEach(subscription => subscription.remove())
  }, [active, cancel])

  const onModalShow = useCallback(() => {
    if (!activeRef.current) return
    shown.current = true
    startIfReady()
  }, [startIfReady])

  const onInputLayout = useCallback((event: LayoutChangeEvent) => {
    if (!activeRef.current || event.nativeEvent.layout.width <= 0 || event.nativeEvent.layout.height <= 0) return
    laidOut.current = true
    startIfReady()
  }, [startIfReady])

  return { onModalShow, onInputLayout, cancel }
}

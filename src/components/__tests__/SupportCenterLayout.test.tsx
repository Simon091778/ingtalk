import { render } from '@testing-library/react-native'
import { KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SupportCenter } from '../SupportCenter'

jest.mock('../../lib/supabase', () => ({ supabase: null }))
jest.mock('../../i18n', () => ({
  useI18n: () => ({ language: 'ko', locale: 'ko-KR', t: (key: string) => key }),
}))
jest.mock('../SwipeDismissView', () => ({ SwipeDismissView: ({ children }: { children: React.ReactNode }) => children }))

const metrics = {
  frame: { x: 0, y: 0, width: 320, height: 568 },
  insets: { top: 24, right: 0, bottom: 24, left: 0 },
}

test('support composer keeps its action row above the Android keyboard without a focus timer workaround', () => {
  const originalPlatform = Platform.OS
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  const screen = render(<SafeAreaProvider initialMetrics={metrics}>
    <SupportCenter controlledVisible showTrigger={false} />
  </SafeAreaProvider>)
  try {
    const viewport = screen.UNSAFE_getByType(KeyboardAvoidingView)
    expect(viewport.props.enabled).toBe(true)
    expect(viewport.props.behavior).toBe('padding')
    expect(screen.getByPlaceholderText('문의 내용을 입력하세요').props.onFocus).toBeUndefined()
    expect(screen.getByText('전송')).toBeTruthy()
  } finally {
    screen.unmount()
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
  }
})

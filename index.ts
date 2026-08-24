import 'react-native-gesture-handler'
import { registerRootComponent } from 'expo'
import { createElement } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import App from './App'
import { I18nProvider } from './src/i18n'
import { initializeObservability, wrapWithErrorMonitoring } from './src/lib/observability'

initializeObservability()

function Root() {
  return createElement(GestureHandlerRootView, { style: { flex: 1 } }, createElement(SafeAreaProvider, null, createElement(I18nProvider, null, createElement(App))))
}

registerRootComponent(wrapWithErrorMonitoring(Root))

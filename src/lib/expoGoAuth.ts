import Constants, { ExecutionEnvironment } from 'expo-constants'
import { Platform } from 'react-native'

// Explicit development-only transport; never a fallback for native ID failures.
export function isExpoGoAuthTesting(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__
    && (Platform.OS === 'ios' || Platform.OS === 'android')
    && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
}

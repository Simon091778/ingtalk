import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

// Session/profile restoration is not an interactive login step. Keep the same
// neutral screen throughout startup instead of flashing authentication controls.
export function AppStartupScreen({ language = 'ko' }: { language?: 'ko' | 'en' }) {
  return <View testID="app-startup-screen" style={styles.screen} accessibilityLabel={language === 'ko' ? '앱 준비 중' : 'Preparing app'}>
    <Text style={styles.brand}>{language === 'ko' ? '잉톡' : 'Ingtalk'}</Text>
    <ActivityIndicator color="#F26B4B" accessibilityLabel="Checking session" />
  </View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF9F5' },
  brand: { color: '#F26B4B', fontSize: 28, fontWeight: '900', marginBottom: 18 },
})

import { StyleSheet, View } from 'react-native'

export function DropdownChevron({ color, expanded = false }: { color: string; expanded?: boolean }) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.frame}>
    <View style={[styles.mark, { borderColor: color }, expanded && styles.markExpanded]} />
  </View>
}

const styles = StyleSheet.create({
  frame: { width: 14, height: 14, marginLeft: 3, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 7, height: 7, marginTop: -3, borderRightWidth: 1.8, borderBottomWidth: 1.8, transform: [{ rotate: '45deg' }] },
  markExpanded: { marginTop: 3, transform: [{ rotate: '-135deg' }] },
})

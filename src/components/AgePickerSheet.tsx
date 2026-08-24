import { useEffect, useRef, useState } from 'react'
import { FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../i18n/localizedUi'
import { useI18n } from '../i18n'

const MIN_AGE = 19
const MAX_AGE = 80
const ROW_HEIGHT = 52
const PICKER_HEIGHT = 260
const ages = Array.from({ length: MAX_AGE - MIN_AGE + 1 }, (_, index) => MIN_AGE + index)

export function AgePickerSheet({ visible, value, onCancel, onConfirm }: { visible: boolean; value: number | null; onCancel: () => void; onConfirm: (age: number) => void }) {
  const { language } = useI18n()
  const insets = useSafeAreaInsets()
  const listRef = useRef<FlatList<number>>(null)
  const [draftAge, setDraftAge] = useState(value && value >= MIN_AGE && value <= MAX_AGE ? value : MIN_AGE)

  useEffect(() => {
    if (!visible) return
    const nextAge = value && value >= MIN_AGE && value <= MAX_AGE ? value : MIN_AGE
    setDraftAge(nextAge)
    const timer = setTimeout(() => listRef.current?.scrollToOffset({ offset: (nextAge - MIN_AGE) * ROW_HEIGHT, animated: false }), 0)
    return () => clearTimeout(timer)
  }, [value, visible])

  if (!visible) return null
  const updateFromOffset = (offset: number) => setDraftAge(ages[Math.max(0, Math.min(ages.length - 1, Math.round(offset / ROW_HEIGHT)))] ?? MIN_AGE)

  const picker = <View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={language === 'ko' ? '나이 선택 취소' : 'Cancel age selection'} style={styles.backdrop} onPress={onCancel} />
    <View style={[styles.sheet, Platform.OS === 'android' && { paddingBottom: Math.max(insets.bottom, 18) }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.headerButton}><Text style={styles.cancel}>{language === 'ko' ? '취소' : 'Cancel'}</Text></Pressable>
        <Text style={styles.title}>{language === 'ko' ? '나이 선택' : 'Select age'}</Text>
        <Pressable accessibilityRole="button" onPress={() => onConfirm(draftAge)} style={[styles.headerButton, styles.doneButton]}><Text style={styles.done}>{language === 'ko' ? '완료' : 'Done'}</Text></Pressable>
      </View>
      <View style={styles.pickerFrame}>
        <View pointerEvents="none" style={styles.selectionBand} />
        <FlatList ref={listRef} data={ages} keyExtractor={age => String(age)} getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })} contentContainerStyle={styles.pickerContent} showsVerticalScrollIndicator={false} snapToInterval={ROW_HEIGHT} decelerationRate="fast" nestedScrollEnabled onScroll={event => updateFromOffset(event.nativeEvent.contentOffset.y)} scrollEventThrottle={16} renderItem={({ item }) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: item === draftAge }} onPress={() => { setDraftAge(item); listRef.current?.scrollToOffset({ offset: (item - MIN_AGE) * ROW_HEIGHT, animated: true }) }} style={styles.ageRow}><Text style={[styles.ageText, item === draftAge && styles.ageTextSelected]}>{language === 'ko' ? `${item}세` : `${item} years old`}</Text></Pressable>} />
      </View>
    </View>
  </View>

  if (Platform.OS === 'android') return <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onCancel}>{picker}</Modal>
  return picker
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 1000, elevation: 1000, justifyContent: 'flex-end' }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 23, 42, 0.42)' }, sheet: { backgroundColor: '#FFF9F5', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', paddingBottom: 18 },
  header: { height: 58, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#EEE7E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerButton: { width: 82, minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }, doneButton: { alignItems: 'flex-end' }, cancel: { color: '#78716C', fontSize: 14, fontWeight: '800' }, done: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, title: { color: '#1F2937', fontSize: 16, fontWeight: '900' },
  pickerFrame: { height: PICKER_HEIGHT, overflow: 'hidden' }, pickerContent: { paddingVertical: (PICKER_HEIGHT - ROW_HEIGHT) / 2 }, selectionBand: { position: 'absolute', left: 20, right: 20, top: (PICKER_HEIGHT - ROW_HEIGHT) / 2, height: ROW_HEIGHT, borderRadius: 14, backgroundColor: '#FFF0E9', borderWidth: 1, borderColor: '#FFD1C2' }, ageRow: { height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }, ageText: { color: '#9A8F89', fontSize: 17, fontWeight: '700' }, ageTextSelected: { color: '#C2410C', fontSize: 21, fontWeight: '900' },
})

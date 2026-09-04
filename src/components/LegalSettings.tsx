import { useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, View } from 'react-native'
import { Text } from '../i18n/localizedUi'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { PRIVACY_POLICY_TEXT, TERMS_OF_SERVICE_TEXT } from '../content/legal'
import { PRIVACY_POLICY_TEXT_EN, TERMS_OF_SERVICE_TEXT_EN } from '../content/legal.en'
import { SwipeDismissView } from './SwipeDismissView'
import { useI18n } from '../i18n'

type LegalDocument = 'terms' | 'privacy'

const documents: Record<LegalDocument, { title: string; body: string }> = {
  terms: { title: '이용약관', body: TERMS_OF_SERVICE_TEXT },
  privacy: { title: '개인정보처리방침', body: PRIVACY_POLICY_TEXT },
}

export function LegalSettings() {
  const { language, t } = useI18n()
  const insets = useSafeAreaInsets()
  const [visible, setVisible] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)
  const [selected, setSelected] = useState<LegalDocument>('terms')
  const document = language === 'en'
    ? selected === 'terms' ? { title: 'Terms of Service', body: TERMS_OF_SERVICE_TEXT_EN } : { title: 'Privacy Policy', body: PRIVACY_POLICY_TEXT_EN }
    : documents[selected]
  const modalTopInset = Math.max(insets.top, Platform.OS === 'ios' ? 50 : (StatusBar.currentHeight ?? 24))

  const open = () => {
    setClosingBySwipe(false)
    setSelected('terms')
    setVisible(true)
  }

  return <>
    <Pressable style={styles.menuCard} onPress={open}>
      <View style={styles.menuIcon}><Text style={styles.menuIconText}>§</Text></View>
      <View style={styles.menuBody}>
        <Text style={styles.menuTitle}>{t('termsAndPrivacy')}</Text>
        <Text style={styles.menuDescription}>{t('termsAndPrivacyDescription')}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>

    <Modal visible={visible} animationType="none" statusBarTranslucent={false} onRequestClose={() => setVisible(false)}>
      <SwipeDismissView visible={visible} onDismissStart={() => setClosingBySwipe(true)} onDismiss={() => setVisible(false)}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={[styles.modalTopArea, { paddingTop: modalTopInset }]}>
          <View style={styles.header}>
            <Pressable style={styles.headerButton} onPress={() => setVisible(false)} hitSlop={10}>
              <Text style={styles.close}>닫기</Text>
            </Pressable>
            <Text pointerEvents="none" style={styles.headerTitle}>약관 및 개인정보</Text>
            <View style={styles.headerButton} />
          </View>
        </View>

        <View style={styles.tabs}>
          {(Object.keys(documents) as LegalDocument[]).map(key => (
            <Pressable key={key} onPress={() => setSelected(key)} style={[styles.tab, selected === key && styles.tabActive]}>
              <Text style={[styles.tabText, selected === key && styles.tabTextActive]}>{documents[key].title}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} key={selected}>
          <Text style={styles.documentTitle}>{document.title}</Text>
          <Text selectable style={styles.documentBody}>{document.body}</Text>
        </ScrollView>
      </SafeAreaView>
      </SwipeDismissView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  menuCard: { minHeight: 74, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 16, marginTop: 10, borderWidth: 1, borderColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center' },
  menuIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#FFF0E9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  menuIconText: { color: '#F26B4B', fontSize: 20, fontWeight: '900' },
  menuBody: { flex: 1 },
  menuTitle: { color: '#374151', fontSize: 15, fontWeight: '900' },
  menuDescription: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 4 },
  chevron: { color: '#A8A29E', fontSize: 27, marginLeft: 8, marginBottom: 3 },
  modalSafe: { flex: 1, backgroundColor: '#FFF9F5' },
  modalTopArea: { backgroundColor: '#FFF9F5', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerButton: { width: 86, minHeight: 56, paddingLeft: 18, justifyContent: 'center' },
  close: { color: '#F26B4B', fontSize: 15, fontWeight: '900' },
  headerTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingVertical: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' },
  tab: { flex: 1, minHeight: 40, borderRadius: 12, backgroundColor: '#F5F1EE', alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: '#F26B4B' },
  tabText: { color: '#6B625D', fontSize: 12, fontWeight: '800' },
  tabTextActive: { color: '#FFFFFF' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 48 },
  documentTitle: { color: '#1F2937', fontSize: 20, fontWeight: '900', marginBottom: 16 },
  documentBody: { color: '#4B5563', fontSize: 13, lineHeight: 22 },
})

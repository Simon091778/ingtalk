import { useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text as NativeText, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Text } from '../i18n/localizedUi'
import { serviceCountries, type AppLanguage, type RegionalPreferences, type ServiceCountry, useI18n } from '../i18n'
import { SwipeDismissView } from './SwipeDismissView'

function Choice<T extends string>({ label, value, selected, onPress }: { label: string; value: T; selected: T; onPress: (value: T) => void }) {
  const active = value === selected
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: active }} onPress={() => onPress(value)} style={[styles.choice, active && styles.choiceActive]}><NativeText style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</NativeText>{active && <NativeText style={styles.check}>✓</NativeText>}</Pressable>
}

export function RegionalSelector({ onboarding = false, onContinue }: { onboarding?: boolean; onContinue?: () => void }) {
  const i18n = useI18n()
  const [language, setLanguage] = useState<AppLanguage>(i18n.language)
  const [country, setCountry] = useState<ServiceCountry>(i18n.country)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await i18n.updatePreferences({ language, country })
      onContinue?.()
    } finally {
      setSaving(false)
    }
  }
  const labels = language === 'ko'
    ? { header: '언어 및 국가 설정', title: i18n.isRecoveryConfirmation ? '복구된 설정을 확인해 주세요' : '언어와 국가를 선택해 주세요', description: i18n.isRecoveryConfirmation ? '이전에 사용한 언어와 국가입니다. 확인 후 계속해 주세요.' : '언어와 국가는 나중에 내 정보에서 변경할 수 있어요.', language: '언어', country: '서비스 국가', save: '저장', continue: '저장하고 계속하기', korea: '대한민국', us: '미국', other: '기타 지역' }
    : { header: 'Language & Country', title: i18n.isRecoveryConfirmation ? 'Confirm your restored settings' : 'Choose your language and country', description: i18n.isRecoveryConfirmation ? 'These are the language and country you used before. Confirm to continue.' : 'Change these later in My Info.', language: 'Language', country: 'Service country', save: 'Save', continue: 'Save and continue', korea: 'South Korea', us: 'United States', other: 'Other regions' }
  return <SafeAreaView edges={['top', 'bottom']} style={[styles.selectorSafe, onboarding && styles.onboarding]}>
    <View style={styles.header}>
      <View style={styles.headerButton} />
      <NativeText numberOfLines={1} style={styles.headerTitle}>{labels.header}</NativeText>
      <Pressable accessibilityRole="button" accessibilityLabel={labels.save} accessibilityState={{ busy: saving, disabled: saving }} disabled={saving} onPress={() => void save()} style={[styles.headerButton, styles.headerSaveButton, saving && styles.disabled]}>{saving ? <ActivityIndicator size="small" color="#F26B4B" /> : <NativeText style={styles.headerSaveText}>{labels.save}</NativeText>}</Pressable>
    </View>
    <ScrollView
      style={styles.selectorScroll}
      contentContainerStyle={styles.selector}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      showsVerticalScrollIndicator
      alwaysBounceVertical
      overScrollMode="always"
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={styles.heading}>{labels.title}</Text><Text style={styles.description}>{labels.description}</Text>
      <Text style={styles.label}>{labels.language}</Text>
      <Choice label="한국어" value="ko" selected={language} onPress={setLanguage} /><Choice label="English" value="en" selected={language} onPress={setLanguage} />
      <Text style={styles.label}>{labels.country}</Text>
      {serviceCountries.map(item => <Choice key={item.code} label={language === 'ko' ? item.ko : item.en} value={item.code} selected={country} onPress={setCountry} />)}
    </ScrollView>
    <View style={styles.selectorFooter}>
      <Pressable accessibilityRole="button" accessibilityLabel={labels.continue} accessibilityState={{ busy: saving, disabled: saving }} disabled={saving} onPress={() => void save()} style={[styles.save, styles.onboardingSave, saving && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <NativeText style={styles.saveText}>{labels.continue}</NativeText>}</Pressable>
    </View>
  </SafeAreaView>
}

export function RegionalSettings() {
  const i18n = useI18n()
  const selectedCountry = serviceCountries.find(item => item.code === i18n.country)
  const countryLabel = selectedCountry ? (i18n.language === 'ko' ? selectedCountry.ko : selectedCountry.en) : i18n.t('otherRegions')
  const [visible, setVisible] = useState(false)
  const [closingBySwipe, setClosingBySwipe] = useState(false)
  const [draft, setDraft] = useState<RegionalPreferences>({ language: i18n.language, country: i18n.country })
  const [saving, setSaving] = useState(false)
  const open = () => { setDraft({ language: i18n.language, country: i18n.country }); setClosingBySwipe(false); setVisible(true) }
  const draftLabels = draft.language === 'ko'
    ? { close: '닫기', title: '언어 및 국가 설정', language: '언어', country: '서비스 국가', save: '저장' }
    : { close: 'Close', title: 'Language & Country', language: 'Language', country: 'Service country', save: 'Save' }
  const save = async () => {
    if (saving) return
    setSaving(true)
    const savedLanguage = draft.language
    await i18n.updatePreferences(draft)
    setSaving(false)
    setVisible(false)
    setTimeout(() => Alert.alert(
      savedLanguage === 'ko' ? '설정 완료' : 'Settings updated',
      savedLanguage === 'ko' ? '언어와 국가 설정을 적용했습니다.' : 'Your language and country settings have been applied.',
    ), 0)
  }
  const saveButton = () => <Pressable accessibilityRole="button" accessibilityLabel={draftLabels.save} accessibilityState={{ busy: saving, disabled: saving }} disabled={saving} onPress={() => void save()} style={[styles.save, styles.modalFooterSave, saving && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <NativeText style={styles.saveText}>{draftLabels.save}</NativeText>}</Pressable>
  return <>
    <Pressable style={styles.menuCard} onPress={open}><View style={styles.menuIcon}><Text style={styles.menuIconText}>文</Text></View><View style={styles.menuBody}><Text style={styles.menuTitle}>{i18n.t('regionalSettings')}</Text><Text style={styles.menuDescription}>{i18n.t('regionalSettingsDescription')} · {i18n.language === 'ko' ? '한국어' : 'English'} / {countryLabel}</Text></View><Text style={styles.chevron}>›</Text></Pressable>
    <Modal visible={visible} animationType={Platform.OS === 'android' ? 'fade' : closingBySwipe ? 'none' : 'slide'} onRequestClose={() => setVisible(false)}><SwipeDismissView onDismissStart={() => setClosingBySwipe(true)} onDismiss={() => setVisible(false)}><SafeAreaView style={styles.safe}>
      <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={draftLabels.close} style={styles.headerButton} onPress={() => setVisible(false)}><NativeText style={styles.close}>{draftLabels.close}</NativeText></Pressable><NativeText numberOfLines={1} style={styles.headerTitle}>{draftLabels.title}</NativeText><Pressable accessibilityRole="button" accessibilityLabel={draft.language === 'ko' ? '언어 및 국가 설정 저장' : 'Save language and country settings'} accessibilityState={{ busy: saving, disabled: saving }} disabled={saving} onPress={() => void save()} style={[styles.headerButton, styles.headerSaveButton, saving && styles.disabled]}>{saving ? <ActivityIndicator size="small" color="#F26B4B" /> : <NativeText style={styles.headerSaveText}>{draftLabels.save}</NativeText>}</Pressable></View>
      <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled"><NativeText style={styles.label}>{draftLabels.language}</NativeText><Choice label="한국어" value="ko" selected={draft.language} onPress={language => setDraft(current => ({ ...current, language }))} /><Choice label="English" value="en" selected={draft.language} onPress={language => setDraft(current => ({ ...current, language }))} />
      <NativeText style={styles.label}>{draftLabels.country}</NativeText>{serviceCountries.map(item => <Choice key={item.code} label={draft.language === 'ko' ? item.ko : item.en} value={item.code} selected={draft.country} onPress={country => setDraft(current => ({ ...current, country }))} />)}
      </ScrollView>
      <View style={styles.modalFooter}>{saveButton()}</View>
    </SafeAreaView></SwipeDismissView></Modal>
  </>
}

const styles = StyleSheet.create({
  selectorSafe: { flex: 1, backgroundColor: '#FFF9F5' }, selectorScroll: { flex: 1 }, selector: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 20, paddingBottom: 24 }, onboarding: { backgroundColor: '#FFF9F5' }, selectorFooter: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: '#EEE7E2', backgroundColor: '#FFF9F5' }, onboardingSave: { marginTop: 0 }, heading: { color: '#1F2937', fontSize: 25, lineHeight: 34, fontWeight: '900' }, description: { color: '#78716C', fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 14 }, label: { color: '#374151', fontSize: 14, fontWeight: '900', marginTop: 18, marginBottom: 8 }, choice: { minHeight: 52, paddingHorizontal: 16, marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' }, choiceActive: { borderColor: '#F26B4B', backgroundColor: '#FFF0E9' }, choiceText: { flex: 1, color: '#4B5563', fontSize: 14, fontWeight: '700' }, choiceTextActive: { color: '#C24120', fontWeight: '900' }, check: { color: '#F26B4B', fontSize: 18, fontWeight: '900' }, save: { minHeight: 52, borderRadius: 15, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center', marginTop: 24 }, saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' }, disabled: { opacity: 0.55 },
  menuCard: { minHeight: 74, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 16, marginTop: 10, borderWidth: 1, borderColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center' }, menuIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#FFF0E9', alignItems: 'center', justifyContent: 'center', marginRight: 12 }, menuIconText: { color: '#F26B4B', fontSize: 17, fontWeight: '900' }, menuBody: { flex: 1 }, menuTitle: { color: '#374151', fontSize: 15, fontWeight: '900' }, menuDescription: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 4 }, chevron: { color: '#A8A29E', fontSize: 27, marginLeft: 8 },
  safe: { flex: 1, backgroundColor: '#FFF9F5' }, modalScroll: { flex: 1 }, header: { minHeight: 60, paddingTop: 3, borderBottomWidth: 1, borderBottomColor: '#EEE7E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerButton: { width: 82, minHeight: 52, paddingHorizontal: 17, justifyContent: 'center' }, headerSaveButton: { alignItems: 'flex-end' }, headerSaveText: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, close: { color: '#F26B4B', fontSize: 14, fontWeight: '900' }, headerTitle: { flex: 1, color: '#1F2937', fontSize: 16, fontWeight: '900', textAlign: 'center' }, modalContent: { flexGrow: 1, padding: 20, paddingBottom: 44 }, modalFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: '#EEE7E2', backgroundColor: '#FFF9F5' }, modalFooterSave: { marginTop: 0 },
})

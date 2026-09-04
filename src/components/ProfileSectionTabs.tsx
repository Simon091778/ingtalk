import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '../i18n/localizedUi'
import { useI18n } from '../i18n'
import { mainTabListTopGap, mainTabSegmentButtonStyle, mainTabSegmentStyle } from '../lib/mainTabLayout'

export type ProfileSection = 'profile' | 'account' | 'support'

const sections: Array<{ key: ProfileSection; ko: string; en: string }> = [
  { key: 'profile', ko: '프로필', en: 'Profile' },
  { key: 'account', ko: '계정', en: 'Account' },
  { key: 'support', ko: '고객지원', en: 'Support' },
]

export function ProfileSectionTabs({ selected, onSelect }: {
  selected: ProfileSection
  onSelect: (section: ProfileSection) => void
}) {
  const { language } = useI18n()

  return <View testID="profile-section-tabs" accessibilityLabel={language === 'ko' ? '내 정보 세부 메뉴' : 'My Info sections'} style={styles.tabs}>
    {sections.map(section => {
      const active = selected === section.key
      const label = language === 'ko' ? section.ko : section.en
      return <Pressable
        key={section.key}
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        onPress={() => onSelect(section.key)}
        style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && styles.tabPressed]}
      >
        <Text numberOfLines={1} style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
      </Pressable>
    })}
  </View>
}

const styles = StyleSheet.create({
  tabs: {
    ...mainTabSegmentStyle,
    width: '100%',
    marginBottom: mainTabListTopGap,
    backgroundColor: '#F3ECE8',
  },
  tab: {
    ...mainTabSegmentButtonStyle,
  },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#7C2D12',
    shadowOpacity: 0.09,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tabPressed: { opacity: 0.72 },
  tabText: { color: '#78716C', fontSize: 12, lineHeight: 17, fontWeight: '800' },
  tabTextActive: { color: '#C24120', fontWeight: '900' },
})

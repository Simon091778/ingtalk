import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, AppState, FlatList, Image, InputAccessoryView, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, useWindowDimensions, View,
} from 'react-native'
import { Text, TextInput } from './src/i18n/localizedUi'
import { Gesture, GestureDetector, GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import * as Location from 'expo-location'
import { SafeAreaView as InsetSafeAreaView, type Edge } from 'react-native-safe-area-context'
import { talkCards } from './src/demoData'
import { ChatHub, RequestComposer } from './src/components/ChatFlow'
import { Board } from './src/components/Board'
import { ConsentGate, type PermissionPreferences } from './src/components/ConsentGate'
import { GuestProfileOnboarding, type GuestProfile } from './src/components/GuestProfileOnboarding'
import { PermissionSettings } from './src/components/PermissionSettings'
import { LegalSettings } from './src/components/LegalSettings'
import { AccountDeletion } from './src/components/AccountDeletion'
import { SupportCenter } from './src/components/SupportCenter'
import { RegionalSelector, RegionalSettings } from './src/components/RegionalSettings'
import { PointPurchase } from './src/components/PointPurchase'
import { PointDetails } from './src/components/PointDetails'
import { RewardedAdButton } from './src/components/RewardedAdButton'
import { SwipeDismissView } from './src/components/SwipeDismissView'
import { DropdownChevron } from './src/components/DropdownChevron'
import { AgePickerSheet } from './src/components/AgePickerSheet'
import { isSupabaseConfigured, supabase } from './src/lib/supabase'
import { pickProfilePhoto, ProfilePhotoPermissionError, uploadProfilePhoto } from './src/lib/profilePhoto'
import { useChatPushNotifications } from './src/lib/pushNotifications'
import { captureAppError, identifyAnonymousUser } from './src/lib/observability'
import { formatDistanceMeters, formatElapsedMinutes } from './src/lib/displayFormat'
import { publicContentErrorMessage } from './src/lib/contentModeration'
import type { TalkCard, TalkPurpose } from './src/types'
import { formatNumber, useI18n } from './src/i18n'

type Tab = 'home' | 'board' | 'chats' | 'profile'
const purposes: Array<'전체' | TalkPurpose> = ['전체', '수다', '취미', '친구', '연애', '고민상담', '만남', '식사', '산책']
const distanceFilters = [
  { label: '국가', maxMeters: null },
  { label: '전체', maxMeters: null },
  { label: '동네', maxMeters: 30000 },
  { label: '근처', maxMeters: 15000 },
  { label: '내톡', maxMeters: null },
] as const
type DiscoveryCountryFilter = 'ALL' | 'KR' | 'US' | 'OTHER'
const profileGenders = [
  { value: 'male', label: '남성' },
  { value: 'female', label: '여성' },
  { value: 'other', label: '기타' },
  { value: 'private', label: '비공개' },
] as const

function Avatar({ name, size = 52, uri }: { name: string; size?: number; uri?: string | null }) {
  const colors = ['#FFE0D5', '#DBEAFE', '#DCFCE7', '#F3E8FF']
  const color = colors[name.charCodeAt(0) % colors.length]
  return uri ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} /> : <View style={[styles.avatar, styles.originalAvatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}><Text style={styles.avatarText}>{name[0]}</Text></View>
}

function ProfilePhotoViewer({ card, onClose }: { card: TalkCard | null; onClose: () => void }) {
  const { height: screenHeight } = useWindowDimensions()
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const translateX = useSharedValue(0)
  const translateY = useSharedValue(0)
  const savedTranslateX = useSharedValue(0)
  const savedTranslateY = useSharedValue(0)
  const dismissTranslateY = useSharedValue(0)
  const dismissing = useSharedValue(false)

  useEffect(() => {
    scale.value = 1
    savedScale.value = 1
    translateX.value = 0
    translateY.value = 0
    savedTranslateX.value = 0
    savedTranslateY.value = 0
    dismissTranslateY.value = 0
    dismissing.value = false
  }, [card?.id])

  const pinch = Gesture.Pinch()
    .onUpdate(event => { scale.value = Math.min(4, Math.max(1, savedScale.value * event.scale)) })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= 1.01) {
        scale.value = withTiming(1)
        savedScale.value = 1
        translateX.value = withTiming(0)
        translateY.value = withTiming(0)
        savedTranslateX.value = 0
        savedTranslateY.value = 0
      }
    })

  const pan = Gesture.Pan()
    .maxPointers(1)
    .onUpdate(event => {
      if (scale.value <= 1) return
      const limit = (scale.value - 1) * 180
      translateX.value = Math.min(limit, Math.max(-limit, savedTranslateX.value + event.translationX))
      translateY.value = Math.min(limit, Math.max(-limit, savedTranslateY.value + event.translationY))
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value
      savedTranslateY.value = translateY.value
    })

  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDuration(250).onEnd(() => {
    const zoomed = scale.value > 1.05
    scale.value = withTiming(zoomed ? 1 : 2.5)
    savedScale.value = zoomed ? 1 : 2.5
    if (zoomed) {
      translateX.value = withTiming(0)
      translateY.value = withTiming(0)
      savedTranslateX.value = 0
      savedTranslateY.value = 0
    }
  })

  const dismiss = Gesture.Pan().minDistance(12)
    .onUpdate(event => {
      if (scale.value > 1.01 || event.translationX < 0 || event.translationY < 0) return
      const movingRight = Math.abs(event.translationX) > Math.abs(event.translationY)
      dismissTranslateY.value = movingRight ? event.translationX * 0.28 : event.translationY
    })
    .onEnd(event => {
      if (scale.value > 1.01) return
      const swipedRight = event.translationX > 95 && Math.abs(event.translationX) > Math.abs(event.translationY)
      const swipedDown = event.translationY > 95 && Math.abs(event.translationY) >= Math.abs(event.translationX)
      if (swipedRight || swipedDown || event.velocityX > 800 || event.velocityY > 800) {
        dismissing.value = true
        dismissTranslateY.value = withTiming(screenHeight + 40, { duration: 230 }, finished => {
          if (finished) runOnJS(onClose)()
        })
      } else dismissTranslateY.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!dismissing.value) dismissTranslateY.value = withTiming(0, { duration: 180 })
    })
  const gestures = Gesture.Simultaneous(pinch, pan, doubleTap, dismiss)
  const animatedImageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }] }))
  const viewerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dismissTranslateY.value }] }))

  if (!card?.avatarUrl) return null
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.flex}>
      <Animated.View style={[styles.photoPreviewOverlay, viewerStyle]}>
      <SafeAreaView style={styles.photoPreviewSafe}>
        <View style={styles.photoPreviewHeader}><View><Text numberOfLines={1} style={styles.photoPreviewName}>{card.nickname}</Text><Text style={styles.photoPreviewHint}>두 손가락으로 확대 · 한 손가락으로 이동 · 두 번 탭으로 초기화</Text></View><Pressable accessibilityRole="button" accessibilityLabel="프로필 사진 닫기" style={styles.photoPreviewClose} onPress={onClose}><Text style={styles.photoPreviewCloseText}>닫기</Text></Pressable></View>
        <GestureDetector gesture={gestures}><Animated.View style={styles.photoZoomArea}><Animated.Image source={{ uri: card.avatarUrl }} resizeMode="contain" style={[styles.photoPreviewImage, animatedImageStyle]} /></Animated.View></GestureDetector>
      </SafeAreaView>
      </Animated.View>
    </GestureHandlerRootView>
  </Modal>
}

function Card({ item, onRequest, onEdit, onDelete, onHide, onBlock, onMenu, onPhotoPress }: { item: TalkCard; onRequest: () => void; onEdit: () => void; onDelete: () => void; onHide: () => void; onBlock: () => void; onMenu: () => void; onPhotoPress: () => void }) {
  const longPressed = useRef(false)
  const distance = formatDistanceMeters(item.distanceMeters, item.isMine)
  const genderAge = item.gender === 'male' ? `남${item.ageRange}` : item.gender === 'female' ? `여${item.ageRange}` : item.gender === 'other' ? `기타${item.ageRange}` : item.ageRange
  const compactInfo = ` · ${distance} · ${formatElapsedMinutes(item.minutesAgo)}`
  const content = (
    <>
      <View style={styles.cardMain}>
        {item.avatarUrl ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={`${item.nickname}님의 프로필 사진 크게 보기`} hitSlop={5} onPress={event => { event.stopPropagation(); onPhotoPress() }}><Avatar name={item.nickname} size={76} uri={item.avatarUrl} /></Pressable> : <Avatar name={item.nickname} size={76} />}
        <View style={styles.cardTextContent}>
          <View style={styles.topicPurposeLine}><View style={[styles.purposeBadge, styles.originalPurposeBadge]}><Text style={[styles.purposeText, styles.originalPurposeText]}>{item.purpose}</Text></View><Text numberOfLines={1} style={[styles.topicInline, styles.originalDiscoveryBody]}>{item.topic}</Text></View>
          <View style={styles.compactProfileLine}><Text numberOfLines={1} style={[styles.compactProfileText, styles.originalProfileText]}><Text style={[styles.nickname, item.gender === 'male' && styles.nicknameMale, item.gender === 'female' && styles.nicknameFemale]}>{item.nickname}</Text> <Text style={[styles.compactAge, item.gender === 'male' && styles.nicknameMale, item.gender === 'female' && styles.nicknameFemale]}>({genderAge})</Text><Text style={[styles.compactMeta, styles.originalDiscoveryMeta]}>{compactInfo}</Text></Text></View>
        </View>
      </View>
      {item.isMine && <View style={styles.myCardActions}><Pressable style={[styles.requestButton, styles.myCardActionButton, styles.editCardButton, styles.originalDiscoveryButton]} onPress={onEdit}><Text style={styles.requestButtonText}>수정</Text></Pressable><Pressable style={[styles.requestButton, styles.myCardActionButton, styles.deleteCardButton]} onPress={onDelete}><Text style={styles.deleteCardButtonText}>삭제</Text></Pressable></View>}
    </>
  )

  if (item.isMine) return <View style={[styles.card, styles.originalDiscoveryCard, styles.wideDiscoveryCard]}>{content}</View>

  const swipeActions = () => <View style={styles.discoverySwipeActions}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${item.nickname}님에게 대화 신청`} onPress={onRequest} style={[styles.discoverySwipeAction, styles.discoverySwipeRequest]}><Text style={styles.discoverySwipeActionText}>대화신청</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${item.nickname}님의 카드를 내 목록에서 삭제`} onPress={onHide} style={[styles.discoverySwipeAction, styles.discoverySwipeDelete]}><Text style={styles.discoverySwipeActionText}>삭제</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${item.nickname}님 차단`} onPress={onBlock} style={[styles.discoverySwipeAction, styles.discoverySwipeBlock]}><Text style={styles.discoverySwipeActionText}>차단</Text></Pressable>
  </View>

  return <Swipeable renderRightActions={swipeActions} overshootRight={false} friction={2} rightThreshold={36}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.nickname}님에게 대화 신청. 길게 눌러 메뉴 열기`}
      accessibilityHint="왼쪽으로 밀어 대화신청, 삭제, 차단 메뉴를 열 수 있습니다"
      delayLongPress={420}
      onLongPress={() => { longPressed.current = true; onMenu() }}
      onPress={() => { if (longPressed.current) { longPressed.current = false; return }; onRequest() }}
      style={({ pressed }) => [styles.card, styles.originalDiscoveryCard, styles.wideDiscoveryCard, pressed && styles.cardPressed]}
    >
      {content}
    </Pressable>
  </Swipeable>
}

function Home({ onRequest, onWrite, guestProfile, refreshKey }: { onRequest: (card: TalkCard) => void; onWrite: (card?: TalkCard) => void; guestProfile: GuestProfile; refreshKey: number }) {
  const { t, country, language } = useI18n()
  const [distanceFilter, setDistanceFilter] = useState<(typeof distanceFilters)[number]['label']>('전체')
  const [countryFilter, setCountryFilter] = useState<DiscoveryCountryFilter>(country === 'KR' || country === 'US' ? country : 'OTHER')
  const [countryPickerVisible, setCountryPickerVisible] = useState(false)
  const countryFilterLabels: Record<DiscoveryCountryFilter, string> = language === 'ko'
    ? { ALL: '모든 국가', KR: '한국', US: '미국', OTHER: '기타 지역' }
    : { ALL: 'All countries', KR: 'South Korea', US: 'United States', OTHER: 'Other regions' }
  const countryFilterShortLabels: Record<DiscoveryCountryFilter, string> = language === 'ko'
    ? { ALL: '전체', KR: '한국', US: '미국', OTHER: '기타' }
    : { ALL: 'All', KR: 'KR', US: 'US', OTHER: 'Other' }
  const [cards, setCards] = useState<TalkCard[]>(() => isSupabaseConfigured ? [] : talkCards)
  const [myCards, setMyCards] = useState<TalkCard[]>([])
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [photoPreview, setPhotoPreview] = useState<TalkCard | null>(null)
  const [menuCard, setMenuCard] = useState<TalkCard | null>(null)
  const refreshDiscovery = () => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshTick(value => value + 1)
  }
  const chooseDiscoveryCountry = () => setCountryPickerVisible(true)
  useEffect(() => setCountryFilter(country === 'KR' || country === 'US' ? country : 'OTHER'), [country])
  const filtered = useMemo(() => {
    if (distanceFilter === '내톡') return [...myCards].sort((a, b) => a.minutesAgo - b.minutesAgo)
    const selected = distanceFilters.find(item => item.label === distanceFilter)
    const matchingCards = !selected?.maxMeters
      ? cards
      : cards.filter(card => card.distanceMeters != null && card.distanceMeters <= selected.maxMeters)
    return [...matchingCards].sort((a, b) => a.minutesAgo - b.minutesAgo)
  }, [cards, distanceFilter, myCards])

  const deleteMyCard = (card: TalkCard) => {
    if (!supabase) return
    Alert.alert('내 글을 삭제할까요?', '삭제하면 다른 사용자의 발견 목록에서 즉시 사라집니다.', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          void supabase!.rpc('delete_my_conversation_card', { card_uuid: card.id }).then(({ error }) => {
            if (error) {
              Alert.alert('삭제하지 못했어요', error.message)
              return
            }
            setMyCards(current => current.filter(item => item.id !== card.id))
            setRefreshTick(value => value + 1)
            Alert.alert('삭제 완료', '내 글이 발견 목록에서 삭제되었습니다.')
          })
        },
      },
    ])
  }

  const hideCard = (card: TalkCard) => {
    const hide = async () => {
      if (supabase) {
        const { error } = await supabase.rpc('hide_discovery_card', { card_uuid: card.id })
        if (error) { Alert.alert('삭제하지 못했어요', error.message); return }
      }
      setCards(current => current.filter(item => item.id !== card.id))
      setMenuCard(null)
    }
    Alert.alert('이 카드를 삭제할까요?', '상대방의 글은 삭제되지 않고 내 발견 목록에서만 보이지 않게 됩니다.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void hide() },
    ])
  }

  const blockCardUser = (card: TalkCard) => {
    const block = async () => {
      if (supabase) {
        const { error } = await supabase.rpc('block_discovery_user', { blocked_user_uuid: card.authorId })
        if (error) { Alert.alert('차단하지 못했어요', error.message); return }
      }
      setCards(current => current.filter(item => item.authorId !== card.authorId))
      setMenuCard(null)
      Alert.alert('차단 완료', `${card.nickname}님의 카드와 대화 신청이 더 이상 표시되지 않습니다.`)
    }
    Alert.alert(`${card.nickname}님을 차단할까요?`, '서로의 발견 카드와 대화 신청이 보이지 않게 됩니다. 내 정보에서 차단을 해제할 수 있습니다.', [
      { text: '취소', style: 'cancel' },
      { text: '차단', style: 'destructive', onPress: () => void block() },
    ])
  }

  useEffect(() => {
    let mounted = true

    const loadNearbyCards = async () => {
      if (!supabase) {
        if (mounted) setRefreshing(false)
        return
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const currentUserId = sessionData.session?.user.id
        if (currentUserId) {
          const { data: ownCardData, error: ownCardError } = await supabase
            .from('conversation_cards')
            .select('id, author_id, purpose, topic, created_at')
            .eq('author_id', currentUserId)
            .eq('is_active', true)
            .gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
          if (ownCardError) throw ownCardError
          const now = Date.now()
          if (mounted) setMyCards((ownCardData ?? []).map(row => ({
            id: String(row.id),
            authorId: String(row.author_id),
            nickname: guestProfile.nickname,
            ageRange: `${guestProfile.age}세`,
            region: '내 위치',
            purpose: row.purpose as TalkPurpose,
            topic: String(row.topic),
            trustLabel: '내 프로필',
            gender: guestProfile.gender,
            avatarUrl: guestProfile.avatarUrl,
            minutesAgo: Math.max(0, Math.floor((now - new Date(String(row.created_at)).getTime()) / 60000)),
            distanceMeters: 0,
            isMine: true,
          })))
        }

        const permission = await Location.getForegroundPermissionsAsync()
        const locationEnabled = permission.status === 'granted'

        if (locationEnabled) {
          const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
          const { error: updateError } = await supabase.rpc('update_my_location', {
            latitude: current.coords.latitude,
            longitude: current.coords.longitude,
            accuracy_meters: current.coords.accuracy,
          })
          if (updateError) throw updateError
        }

        const { data, error: nearbyError } = await supabase.rpc('discover_conversation_cards', {
          include_distance: locationEnabled,
          max_distance_meters: 50000,
          result_limit: 100,
          country_filter: countryFilter === 'ALL' ? null : countryFilter,
        })
        if (nearbyError) throw nearbyError

        if (mounted && data) {
          const now = Date.now()
          setCards(data.map((row: Record<string, unknown>) => ({
            id: String(row.id),
            authorId: String(row.author_id),
            nickname: String(row.nickname),
            ageRange: `${new Date().getFullYear() - Number(row.birth_year)}세`,
            region: row.region_code === 'UNSET' ? '' : String(row.region_code),
            purpose: row.purpose as TalkPurpose,
            topic: String(row.topic),
            trustLabel: Number(row.trust_score) >= 60 ? '믿을 수 있는 대화자' : '',
            gender: row.gender as TalkCard['gender'],
            avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
            minutesAgo: Math.max(0, Math.floor((now - new Date(String(row.created_at)).getTime()) / 60000)),
            distanceMeters: row.distance_meters == null ? null : Number(row.distance_meters),
          })))
        }
      } catch (reason) {
        const message = typeof reason === 'object' && reason !== null && 'message' in reason ? String(reason.message) : ''
        console.warn('발견 목록의 거리 정보를 불러오지 못했습니다.', message)
      } finally {
        if (mounted) setRefreshing(false)
      }
    }

    void loadNearbyCards()
    return () => { mounted = false }
  }, [countryFilter, refreshKey, refreshTick])

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const channel = client.channel('discovery-card-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_cards' }, () => setRefreshTick(value => value + 1))
      .subscribe()
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') setRefreshTick(value => value + 1)
    })
    return () => {
      appStateSubscription.remove()
      void client.removeChannel(channel)
    }
  }, [])

  return (
    <View style={[styles.flex, styles.originalDiscoveryPage]}>
      <View style={styles.hero}>
        <View><Text style={[styles.discoveryTitle, styles.originalDiscoveryTitle]}>{t('discover')}</Text><Text style={[styles.eyebrow, styles.originalDiscoveryAccent]}>{t('discoverSubtitle')}</Text></View>
        <View style={styles.discoveryHeaderActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="발견 목록 새로고침" accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing} onPress={refreshDiscovery} style={({ pressed }) => [styles.discoveryRefreshButton, refreshing && styles.discoveryRefreshButtonBusy, pressed && !refreshing && styles.discoveryHeaderButtonPressed]}>{refreshing ? <ActivityIndicator size="small" color="#F26B4B" /> : <Text style={styles.discoveryRefreshIcon}>↻</Text>}</Pressable>
          <Pressable onPress={() => onWrite()} style={({ pressed }) => [styles.discoveryWriteButton, styles.originalDiscoveryButton, pressed && styles.discoveryHeaderButtonPressed]}><Text style={styles.discoveryWriteButtonText}>{t('writeTalk')}</Text></Pressable>
        </View>
      </View>
      <View style={styles.filterBar}>
        {distanceFilters.map(item => { const isCountry = item.label === '국가'; const active = !isCountry && distanceFilter === item.label; return <Pressable key={item.label} accessibilityLabel={isCountry ? `${language === 'ko' ? '국가 필터' : 'Country filter'}: ${countryFilterLabels[countryFilter]}` : undefined} accessibilityState={isCountry ? { expanded: countryPickerVisible } : undefined} onPress={isCountry ? chooseDiscoveryCountry : () => setDistanceFilter(item.label)} style={[styles.filter, styles.discoveryFilter, styles.originalDiscoveryFilter, active && styles.filterActive, active && styles.originalDiscoveryButton, isCountry && styles.discoveryCountryFilter]}><Text numberOfLines={1} style={[styles.filterText, styles.discoveryFilterText, styles.originalDiscoveryFilterText, active && styles.filterTextActive, isCountry && styles.discoveryCountryFilterText]}>{isCountry ? `${language === 'ko' ? '국가' : 'Country'}·${countryFilterShortLabels[countryFilter]}` : item.label}</Text>{isCountry && <DropdownChevron color="#C24120" expanded={countryPickerVisible} />}</Pressable> })}
      </View>
      <FlatList style={styles.discoveryList} data={filtered} keyExtractor={item => item.id} renderItem={({ item }) => <Card item={item} onRequest={() => onRequest(item)} onEdit={() => onWrite(item)} onDelete={() => deleteMyCard(item)} onHide={() => hideCard(item)} onBlock={() => blockCardUser(item)} onMenu={() => setMenuCard(item)} onPhotoPress={() => setPhotoPreview(item)} />} contentContainerStyle={[styles.list, styles.wideDiscoveryList]} showsVerticalScrollIndicator={false} alwaysBounceVertical overScrollMode="always" refreshing={refreshing} onRefresh={refreshDiscovery} ListHeaderComponent={distanceFilter === '내톡' ? <Text style={[styles.sectionTitle, styles.myTalkSectionTitle]}>내 대화 카드</Text> : null} ListEmptyComponent={<Text style={styles.emptyText}>{distanceFilter === '내톡' ? '아직 작성한 대화 카드가 없어요.' : <>아직 주변에 등록된 대화 카드가 없어요.{`\n`}화면을 아래로 당겨 새로고침해 보세요.</>}</Text>} />
      <Modal visible={countryPickerVisible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setCountryPickerVisible(false)}><Pressable style={styles.countryPickerOverlay} onPress={() => setCountryPickerVisible(false)}><Pressable style={styles.countryPickerSheet} onPress={event => event.stopPropagation()}><View style={styles.countryPickerHeader}><View><Text style={styles.countryPickerTitle}>{language === 'ko' ? '국가 선택' : 'Select country'}</Text><Text style={styles.countryPickerDescription}>{language === 'ko' ? '발견 목록에서 볼 국가를 선택해 주세요.' : 'Choose which country to show in Discover.'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={language === 'ko' ? '국가 선택 닫기' : 'Close country picker'} onPress={() => setCountryPickerVisible(false)} style={styles.countryPickerClose}><Text style={styles.countryPickerCloseText}>×</Text></Pressable></View><ScrollView style={styles.countryPickerList} contentContainerStyle={styles.countryPickerListContent} nestedScrollEnabled>{(['ALL', 'KR', 'US', 'OTHER'] as DiscoveryCountryFilter[]).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: countryFilter === value }} onPress={() => { setCountryFilter(value); setCountryPickerVisible(false) }} style={[styles.countryPickerOption, countryFilter === value && styles.countryPickerOptionActive]}><Text style={[styles.countryPickerOptionText, countryFilter === value && styles.countryPickerOptionTextActive]}>{countryFilterLabels[value]}</Text>{countryFilter === value && <Text style={styles.countryPickerCheck}>✓</Text>}</Pressable>)}</ScrollView></Pressable></Pressable></Modal>
      <ProfilePhotoViewer card={photoPreview} onClose={() => setPhotoPreview(null)} />
      <Modal visible={Boolean(menuCard)} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setMenuCard(null)}>
        <Pressable accessibilityRole="button" accessibilityLabel="카드 메뉴 닫기" style={styles.discoveryMenuOverlay} onPress={() => setMenuCard(null)}>
          <Pressable accessibilityRole="menu" style={styles.discoveryMenuSheet} onPress={event => event.stopPropagation()}>
            <View style={styles.discoveryMenuHandle} />
            <Text numberOfLines={1} style={styles.discoveryMenuTitle}>{menuCard?.nickname}</Text>
            <Pressable accessibilityRole="menuitem" onPress={() => { const card = menuCard; setMenuCard(null); if (card) onRequest(card) }} style={styles.discoveryMenuItem}><Text style={styles.discoveryMenuRequestText}>대화신청</Text><Text style={styles.discoveryMenuChevron}>›</Text></Pressable>
            <Pressable accessibilityRole="menuitem" onPress={() => { if (menuCard) hideCard(menuCard) }} style={styles.discoveryMenuItem}><Text style={styles.discoveryMenuItemText}>삭제</Text><Text style={styles.discoveryMenuDescription}>내 발견 목록에서만 숨기기</Text></Pressable>
            <Pressable accessibilityRole="menuitem" onPress={() => { if (menuCard) blockCardUser(menuCard) }} style={[styles.discoveryMenuItem, styles.discoveryMenuDangerItem]}><Text style={styles.discoveryMenuDangerText}>차단</Text><Text style={styles.discoveryMenuDescription}>서로의 카드와 신청 숨기기</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setMenuCard(null)} style={styles.discoveryMenuCancel}><Text style={styles.discoveryMenuCancelText}>취소</Text></Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function WriteCard({ guestProfile, onComplete, onCancel, initialCard }: { guestProfile: GuestProfile; onComplete?: () => void; onCancel: () => void; initialCard?: TalkCard | null }) {
  const [topic, setTopic] = useState(initialCard?.topic ?? '')
  const [purpose, setPurpose] = useState<TalkPurpose>(initialCard?.purpose ?? '수다')
  const [submitting, setSubmitting] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const editing = Boolean(initialCard)

  useEffect(() => {
    setTopic(initialCard?.topic ?? '')
    setPurpose(initialCard?.purpose ?? '수다')
  }, [initialCard?.id])
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  const topicLength = topic.trim().length
  const topicValid = topicLength >= 1 && topicLength <= 120
  const submitCard = async () => {
    if (submitting) return
    if (!topicValid) {
      Alert.alert('글을 작성해 주세요', '남기고 싶은 말을 공백을 제외하고 1자 이상 입력해 주세요.')
      return
    }
    setSubmitting(true)
    try {
      if (!supabase) {
        Alert.alert('등록 완료', '데모 대화 카드가 등록되었어요.')
        setTopic('')
        return
      }
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user.id
      if (!userId) throw new Error('익명 세션을 찾지 못했습니다.')
      const { error } = initialCard
        ? await supabase.rpc('update_my_conversation_card', {
            card_uuid: initialCard.id,
            card_purpose: purpose,
            card_topic: topic.trim(),
          })
        : await supabase.rpc('publish_conversation_card', {
            card_purpose: purpose,
            card_topic: topic.trim(),
          })
      if (error) throw error
      Alert.alert(editing ? '수정 완료' : '등록 완료', '작성 또는 수정한 시점부터 30일 동안 발견 목록에 표시됩니다.')
      setTopic('')
      onComplete?.()
    } catch (reason) {
      captureAppError(reason, 'talk_card', editing ? 'update' : 'create')
      const message = publicContentErrorMessage(reason, '카드를 등록하지 못했습니다.')
      Alert.alert('등록 실패', message.includes('conversation_cards_topic_check') ? '남기고 싶은 말은 1~120자로 입력해 주세요.' : message)
    } finally {
      setSubmitting(false)
    }
  }
  const renderActions = () => <View style={styles.writeCardFooter}><Pressable disabled={submitting} style={styles.writeCardCancel} onPress={onCancel}><Text style={styles.writeCardCancelText}>취소</Text></Pressable><Pressable disabled={!topicValid || submitting} style={[styles.primaryButton, styles.writeCardSubmit, (!topicValid || submitting) && styles.disabled]} onPress={submitCard}><Text style={styles.primaryButtonText}>{submitting ? (editing ? '수정 중…' : '등록 중…') : (editing ? '수정 완료' : '대화 카드 등록')}</Text></Pressable></View>
  return <View style={styles.writeCardContainer}>
    <ScrollView style={styles.flex} contentContainerStyle={[styles.page, styles.writeCardPage]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
      <Text style={styles.pageTitle}>{editing ? '대화 카드 수정' : '대화 카드 만들기'}</Text><Text style={styles.pageSubtitle}>{editing ? '내용을 수정하면 카드가 최신 글로 갱신돼요.' : '하고 싶은 이야기를 먼저 알려주세요.'}</Text>
      <View style={styles.authorPreview}><Avatar name={guestProfile.nickname} size={48} uri={guestProfile.avatarUrl} /><View style={styles.authorPreviewBody}><Text style={styles.authorPreviewName}>{guestProfile.nickname}</Text><Text style={styles.authorPreviewMeta}>{guestProfile.age}세</Text></View></View>
      <Text style={styles.label}>대화 목적</Text><View style={styles.wrap}>{purposes.slice(1).map(item => <Pressable key={item} onPress={() => setPurpose(item as TalkPurpose)} style={[styles.filter, purpose === item && styles.filterActive]}><Text style={[styles.filterText, purpose === item && styles.filterTextActive]}>{item}</Text></Pressable>)}</View>
      <Text style={styles.label}>어떤 이야기를 나누고 싶나요?</Text>
      <TextInput value={topic} onChangeText={setTopic} multiline maxLength={120} inputAccessoryViewID={Platform.OS === 'ios' ? 'talk-card-keyboard-actions' : undefined} placeholder="예: 이번 주말 전시 같이 볼 사람 있나요?" placeholderTextColor="#9CA3AF" style={styles.textarea} />
      <Text style={[styles.counter, topic.length > 0 && !topicValid && styles.counterWarning]}>{topicLength}/120 · 최소 1자</Text>
      <View style={styles.guide}><Text style={styles.guideTitle}>좋은 대화를 위한 약속</Text><Text style={styles.guideText}>개인 연락처, 선정적인 표현, 만남 강요는 작성할 수 없어요.</Text></View>
    </ScrollView>
    {(Platform.OS !== 'ios' || !keyboardVisible) && renderActions()}
    {Platform.OS === 'ios' && <InputAccessoryView nativeID="talk-card-keyboard-actions" backgroundColor="#FFF9F5">{renderActions()}</InputAccessoryView>}
  </View>
}

function Profile({ guestProfile, onEdit, onCharge, onDeleted, refreshKey }: { guestProfile: GuestProfile; onEdit: () => void; onCharge: () => void; onDeleted: () => void; refreshKey: number }) {
  const { language, t } = useI18n()
  const [points, setPoints] = useState<number | null>(null)
  const [attendanceAvailable, setAttendanceAvailable] = useState<boolean | null>(null)
  const [claimingAttendance, setClaimingAttendance] = useState(false)
  const [pointDetailsVisible, setPointDetailsVisible] = useState(false)
  useEffect(() => {
    if (!supabase) { setPoints(100); setAttendanceAvailable(true); return }
    void Promise.all([supabase.rpc('my_point_balance'), supabase.rpc('my_attendance_status')]).then(([balanceResult, attendanceResult]) => {
      if (balanceResult.error) console.warn('포인트를 불러오지 못했습니다.', balanceResult.error.message)
      else setPoints(Number(balanceResult.data ?? 0))
      if (attendanceResult.error) console.warn('출석 상태를 불러오지 못했습니다.', attendanceResult.error.message)
      else setAttendanceAvailable(Boolean(attendanceResult.data?.[0]?.available))
    })
  }, [refreshKey])
  const claimAttendance = async () => {
    if (!supabase || attendanceAvailable !== true || claimingAttendance) return
    setClaimingAttendance(true)
    const { data, error } = await supabase.rpc('claim_attendance_reward')
    setClaimingAttendance(false)
    if (error) {
      captureAppError(error, 'points', 'claim_attendance')
      Alert.alert('출석체크 실패', error.message.includes('function') || error.message.includes('schema cache') ? '포인트 보상 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
      return
    }
    const result = data?.[0]
    setPoints(Number(result?.balance ?? points ?? 0))
    setAttendanceAvailable(false)
    const rewardGuide = language === 'ko'
      ? '다른 무료 충전 방법\n• 광고 시청: +50P\n• 톡쓰기 등록: +50P\n• 익명 게시글 작성: +50P\n• 익명 댓글 작성: +50P\n\n각 항목은 24시간에 한 번 받을 수 있어요.'
      : 'Other ways to earn free points\n• Watch an ad: +50P\n• Publish a talk card: +50P\n• Create an anonymous post: +50P\n• Write an anonymous comment: +50P\n\nEach reward is available once every 24 hours.'
    Alert.alert(
      result?.awarded ? '출석체크 완료' : '이미 출석했어요',
      `${result?.awarded ? '출석체크 보상 50P가 충전되었습니다.' : '마지막 출석체크 후 24시간이 지나면 다시 받을 수 있어요.'}\n\n${rewardGuide}`,
    )
  }
  return <ScrollView contentContainerStyle={[styles.page, styles.profilePageLayout, Platform.OS === 'ios' && styles.profilePageIos]}>
    <View style={[styles.profilePageHeader, Platform.OS === 'ios' && styles.profilePageHeaderIos]}><Text style={[styles.pageTitle, styles.profilePageTitle]}>{t('myProfile')}</Text><Text style={styles.profilePageSubtitle}>{t('profileSubtitle')}</Text></View>
    <Pressable accessibilityRole="button" accessibilityLabel={t('editProfile')} onPress={onEdit} style={({ pressed }) => [styles.profileCard, Platform.OS === 'ios' && styles.profileCardIos, pressed && styles.profileCardPressed]}>
      <Avatar name={guestProfile.nickname} size={54} uri={guestProfile.avatarUrl} />
      <View style={styles.profileSummary}>
        <Text style={styles.profileName} numberOfLines={1}>{guestProfile.nickname}</Text>
        <Text style={styles.profileMeta}>{guestProfile.age}세 · {guestProfile.gender === 'male' ? '남성' : guestProfile.gender === 'female' ? '여성' : '기타'}</Text>
      </View>
      <View style={styles.profileEditButton}><Text style={styles.profileEditButtonText}>{t('editProfile')}</Text></View>
    </Pressable>
    <View style={[styles.pointCard, Platform.OS === 'ios' && styles.pointCardIos]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('points')} onPress={() => setPointDetailsVisible(true)} style={styles.pointCardHeader}><View style={styles.pointCardHeading}><Text style={styles.pointCardTitle}>{t('points')}</Text><Text style={styles.pointCardDescription}>{t('pointsDescription')}</Text></View><Text style={styles.pointValue}>{points == null ? '—' : `${formatNumber(points, language)}P`}</Text></Pressable>
      <Pressable onPress={onCharge} style={styles.chargeButton} testID="open-point-purchase"><Text style={styles.chargeButtonText}>{t('charge')}</Text><Text style={styles.chargeButtonArrow}>›</Text></Pressable>
      <View style={styles.rewardActionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={language === 'ko' ? '출석체크 50포인트 받기' : 'Claim 50 points for daily check-in'} disabled={attendanceAvailable !== true || claimingAttendance} onPress={() => void claimAttendance()} style={[styles.rewardActionButton, styles.attendanceButton, (attendanceAvailable !== true || claimingAttendance) && styles.attendanceButtonDisabled]}><Text style={styles.rewardActionIcon}>✓</Text><Text numberOfLines={2} style={styles.attendanceButtonText}>{claimingAttendance ? '출석 확인 중…' : attendanceAvailable === null ? '출석 상태 확인 중…' : attendanceAvailable ? '출석체크 · +50P' : '출석 완료 · 24시간 후'}</Text></Pressable>
        <RewardedAdButton language={language} onBalanceChanged={setPoints} />
      </View>
    </View>
    <RegionalSettings />
    <PermissionSettings />
    <LegalSettings />
    <SupportCenter />
    <AccountDeletion onDeleted={onDeleted} />
    <PointDetails visible={pointDetailsVisible} balance={points} attendanceAvailable={attendanceAvailable} claimingAttendance={claimingAttendance} onClose={() => setPointDetailsVisible(false)} onCharge={() => { setPointDetailsVisible(false); onCharge() }} onAttendance={claimAttendance} />
  </ScrollView>
}

function ProfileEditor({ profile, onClose, onSaved }: { profile: GuestProfile; onClose: () => void; onSaved: (profile: GuestProfile) => void }) {
  const [nickname, setNickname] = useState(profile.nickname)
  const [age, setAge] = useState(String(profile.age))
  const [agePickerVisible, setAgePickerVisible] = useState(false)
  const [gender, setGender] = useState<GuestProfile['gender']>(profile.gender)
  const [avatarUri, setAvatarUri] = useState<string | null>(profile.avatarUrl ?? null)
  const [avatarMimeType, setAvatarMimeType] = useState<string | null>(null)
  const [savingPhoto, setSavingPhoto] = useState(false)
  const [savingDetails, setSavingDetails] = useState(false)
  const [focusedBasicInput, setFocusedBasicInput] = useState<'nickname' | 'age' | null>(null)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const numericAge = Number(age)
  const valid = nickname.trim().length >= 2 && nickname.trim().length <= 9 && Number.isInteger(numericAge) && numericAge >= 19 && numericAge <= 80
  const photoChanged = avatarUri !== profile.avatarUrl
  const detailsChanged = nickname.trim() !== profile.nickname || numericAge !== profile.age || gender !== profile.gender

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true))
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false)
      setFocusedBasicInput(null)
    })
    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  const choosePhoto = async () => {
    try {
      const asset = await pickProfilePhoto()
      if (asset) { setAvatarUri(asset.uri); setAvatarMimeType(asset.mimeType ?? null) }
    } catch (reason) {
      if (reason instanceof ProfilePhotoPermissionError) {
        Alert.alert('사진 접근 권한이 필요해요', reason.canAskAgain ? '사진을 선택하려면 접근 권한을 다시 허용해 주세요.' : '휴대폰 설정에서 잉톡의 사진 접근 권한을 허용해 주세요.', [
          { text: '허용 안 함', style: 'cancel' },
          reason.canAskAgain
            ? { text: '다시 허용하기', onPress: () => void choosePhoto() }
            : { text: '설정 열기', onPress: () => void Linking.openSettings() },
        ])
      } else {
        Alert.alert('사진을 선택하지 못했어요', reason instanceof Error ? reason.message : '다시 시도해 주세요.')
      }
    }
  }
  const savePhoto = async () => {
    if (!photoChanged || savingPhoto || savingDetails) return
    setSavingPhoto(true)
    try {
      let avatarUrl = avatarUri
      if (supabase) {
        const { data } = await supabase.auth.getSession()
        const userId = data.session?.user.id
        if (!userId) throw new Error('익명 사용자 정보를 확인하지 못했습니다.')
        if (avatarUri) avatarUrl = await uploadProfilePhoto(userId, avatarUri, avatarMimeType)
        const { error: profileError } = await supabase.from('profiles').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', userId)
        if (profileError) throw profileError
      } else {
        localStorage.setItem('ingtalk.guest-profile.v1', JSON.stringify({ ...profile, avatarUrl }))
      }
      onSaved({ ...profile, avatarUrl })
      Alert.alert('사진 변경 완료', '프로필 사진을 무료로 변경했습니다.')
    } catch (reason) {
      captureAppError(reason, 'profile', 'update_photo', { hasAvatar: Boolean(avatarUri) })
      const message = typeof reason === 'object' && reason !== null && 'message' in reason ? String(reason.message) : '사진을 변경하지 못했습니다.'
      Alert.alert('사진 변경 실패', message)
    } finally {
      setSavingPhoto(false)
    }
  }
  const saveDetails = async () => {
    if (!valid || !detailsChanged || savingDetails || savingPhoto) return
    setSavingDetails(true)
    try {
      let remainingBalance: number | null = null
      if (supabase) {
        const { data, error } = await supabase.rpc('update_my_profile_details', {
          next_nickname: nickname.trim(),
          next_birth_year: new Date().getFullYear() - numericAge,
          next_gender: gender,
        })
        if (error) throw error
        remainingBalance = Number(data?.[0]?.balance ?? 0)
      } else {
        localStorage.setItem('ingtalk.guest-profile.v1', JSON.stringify({ nickname: nickname.trim(), age: numericAge, gender, avatarUrl: profile.avatarUrl }))
      }
      onSaved({ nickname: nickname.trim(), age: numericAge, gender, avatarUrl: profile.avatarUrl })
      Alert.alert('프로필 수정 완료', remainingBalance == null ? '프로필 정보를 수정했습니다.' : `100P를 사용했습니다.\n남은 포인트: ${remainingBalance.toLocaleString('ko-KR')}P`)
    } catch (reason) {
      captureAppError(reason, 'profile', 'update_details')
      const rawMessage = typeof reason === 'object' && reason !== null && 'message' in reason ? String(reason.message) : ''
      const message = rawMessage.includes('insufficient_points') ? '포인트가 부족합니다. 프로필 정보를 수정하려면 100P가 필요해요.' : rawMessage.includes('function') || rawMessage.includes('schema cache') ? '프로필 수정 SQL 마이그레이션을 Supabase에 적용해 주세요.' : rawMessage || '프로필을 수정하지 못했습니다.'
      Alert.alert('프로필 수정 실패', message)
    } finally {
      setSavingDetails(false)
    }
  }

  const renderDetailsButton = (keyboardAction = false) => <Pressable disabled={!valid || !detailsChanged || savingDetails || savingPhoto} onPress={() => void saveDetails()} style={[styles.primaryButton, keyboardAction && styles.profileKeyboardButton, (!valid || !detailsChanged || savingDetails || savingPhoto) && styles.disabled]}><Text style={styles.primaryButtonText}>{savingDetails ? '수정 중…' : '기본 정보 수정 · 100P'}</Text></Pressable>

  return <InsetSafeAreaView edges={['top', 'bottom']} style={styles.writeModalSafe}>
    <View style={styles.writeModalHeader}><Pressable style={styles.writeModalHeaderButton} onPress={onClose} hitSlop={8}><Text style={styles.writeModalClose}>닫기</Text></Pressable><Text style={styles.writeModalTitle}>프로필 수정</Text><View style={styles.writeModalHeaderButton} /></View>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
    <ScrollView contentContainerStyle={styles.profileEditor} keyboardShouldPersistTaps="handled">
      <View style={styles.profilePhotoGroup}>
        <Text style={styles.profileGroupTitle}>프로필 사진</Text><Text style={styles.profileGroupDescription}>사진 변경은 무료예요</Text>
        <Pressable style={styles.profilePhotoPicker} onPress={choosePhoto}><Avatar name={nickname || profile.nickname} size={96} uri={avatarUri} /><Text style={styles.profilePhotoChangeText}>{avatarUri ? '사진 선택' : '프로필 사진 등록'}</Text></Pressable>
        <Pressable disabled={!photoChanged || savingPhoto || savingDetails} onPress={() => void savePhoto()} style={[styles.profilePhotoSaveButton, (!photoChanged || savingPhoto || savingDetails) && styles.disabled]}><Text style={styles.profilePhotoSaveText}>{savingPhoto ? '사진 저장 중…' : '사진 업데이트'}</Text></Pressable>
      </View>
      <View style={styles.profileDetailsGroup}>
      <Text style={styles.profileGroupTitle}>기본 정보</Text><Text style={styles.profileGroupDescription}>닉네임, 나이, 성별을 한 번 수정할 때 100P가 사용돼요</Text>
      <Text style={styles.label}>닉네임</Text><TextInput value={nickname} onChangeText={setNickname} onFocus={() => setFocusedBasicInput('nickname')} inputAccessoryViewID={Platform.OS === 'ios' ? 'profile-details-keyboard-action' : undefined} maxLength={9} style={styles.profileInput} />
      <Text style={styles.label}>나이</Text><Pressable accessibilityRole="button" accessibilityLabel={`선택된 나이 ${age}세`} onPress={() => { Keyboard.dismiss(); setFocusedBasicInput(null); setAgePickerVisible(true) }} style={[styles.profileInput, styles.profileAgeSelector]}><Text style={styles.profileAgeValue}>{age}세</Text><Text style={styles.profileAgeChevron}>⌄</Text></Pressable>
      <Text style={styles.label}>성별</Text><View style={styles.wrap}>{profileGenders.map(item => <Pressable key={item.value} onPress={() => setGender(item.value)} style={[styles.filter, gender === item.value && styles.filterActive]}><Text style={[styles.filterText, gender === item.value && styles.filterTextActive]}>{item.label}</Text></Pressable>)}</View>
      {renderDetailsButton()}
      </View>
    </ScrollView>
    {keyboardVisible && focusedBasicInput && (Platform.OS === 'android' || focusedBasicInput === 'age') && <View style={styles.profileKeyboardAction}>{renderDetailsButton(true)}</View>}
    </KeyboardAvoidingView>
    {Platform.OS === 'ios' && <InputAccessoryView nativeID="profile-details-keyboard-action" backgroundColor="#FFF9F5"><View style={styles.profileKeyboardAction}>{renderDetailsButton(true)}</View></InputAccessoryView>}
    <AgePickerSheet visible={agePickerVisible} value={numericAge} onCancel={() => setAgePickerVisible(false)} onConfirm={nextAge => { setAge(String(nextAge)); setAgePickerVisible(false) }} />
  </InsetSafeAreaView>
}

function useUnreadChatCount(enabled: boolean) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!enabled || !supabase) return
    const client = supabase
    let mounted = true
    let channel: ReturnType<typeof client.channel> | null = null

    const refresh = async () => {
      const [{ data: roomData, error: roomError }, { data: requestData, error: requestError }] = await Promise.all([
        client.rpc('my_chat_rooms'),
        client.rpc('my_chat_requests'),
      ])
      if (!roomError && !requestError && mounted) {
        const unreadMessages = (roomData ?? []).reduce((total: number, room: { unread_count: number | string }) => total + Number(room.unread_count), 0)
        const pendingReceived = (requestData ?? []).filter((request: { direction: string; request_status: string }) => request.direction === 'received' && request.request_status === 'pending').length
        setCount(unreadMessages + pendingReceived)
      }
    }

    void refresh()
    void client.auth.getSession().then(({ data }) => {
      const userId = data.session?.user.id
      if (!mounted || !userId) return
      channel = client.channel(`global-chat-alerts:${userId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => void refresh())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_requests', filter: `receiver_id=eq.${userId}` }, () => void refresh())
        .subscribe()
    })
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh()
    })

    return () => {
      mounted = false
      appStateSubscription.remove()
      if (channel) void client.removeChannel(channel)
    }
  }, [enabled])

  return [count, setCount] as const
}

export default function App() {
  const i18n = useI18n()
  const [tab, setTab] = useState<Tab>('home')
  const [permissionPreferences, setPermissionPreferences] = useState<PermissionPreferences | null>(null)
  const [guestProfile, setGuestProfile] = useState<GuestProfile | null>(null)
  const [requestCard, setRequestCard] = useState<TalkCard | null>(null)
  const [writeModalVisible, setWriteModalVisible] = useState(false)
  const [editingCard, setEditingCard] = useState<TalkCard | null>(null)
  const [profileEditorVisible, setProfileEditorVisible] = useState(false)
  const [profileEditorClosingBySwipe, setProfileEditorClosingBySwipe] = useState(false)
  const [pointPurchaseVisible, setPointPurchaseVisible] = useState(false)
  const [pointPurchaseClosingBySwipe, setPointPurchaseClosingBySwipe] = useState(false)
  const [regionalOnboardingVisible, setRegionalOnboardingVisible] = useState(false)
  const [feedVersion, setFeedVersion] = useState(0)
  const [tabRefreshVersion, setTabRefreshVersion] = useState<Record<'home' | 'board' | 'chats', number>>({ home: 0, board: 0, chats: 0 })
  const [unreadChatCount, setUnreadChatCount] = useUnreadChatCount(Boolean(guestProfile))
  const openChatsFromNotification = useCallback(() => setTab('chats'), [])
  useChatPushNotifications(Boolean(guestProfile), openChatsFromNotification)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) captureAppError(error, 'authentication', 'restore_session')
      identifyAnonymousUser(data.session?.user.id)
    })
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      identifyAnonymousUser(session?.user.id)
    })
    return () => authListener.subscription.unsubscribe()
  }, [])

  if (!i18n.ready) return <View style={[styles.flex, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF9F5' }]}><ActivityIndicator color="#F26B4B" /></View>
  if (!i18n.hasSelected || regionalOnboardingVisible) return <RegionalSelector onboarding onContinue={() => setRegionalOnboardingVisible(false)} />
  if (!permissionPreferences) return <ConsentGate language={i18n.language} onBack={() => setRegionalOnboardingVisible(true)} onComplete={setPermissionPreferences} />
  if (!guestProfile) return <GuestProfileOnboarding onBack={() => setRegionalOnboardingVisible(true)} onComplete={setGuestProfile} />

  const cardCreated = () => { setFeedVersion(value => value + 1); setWriteModalVisible(false); setEditingCard(null); setTab('home') }
  const openWriter = (card?: TalkCard) => { setEditingCard(card ?? null); setWriteModalVisible(true) }
  const accountDeleted = () => { setGuestProfile(null); setPermissionPreferences(null); setTab('home'); setRequestCard(null); setWriteModalVisible(false); setProfileEditorVisible(false); setPointPurchaseVisible(false); setUnreadChatCount(0) }
  const selectTab = (nextTab: Tab) => {
    setTab(nextTab)
    if (nextTab !== 'profile') setTabRefreshVersion(current => ({ ...current, [nextTab]: current[nextTab] + 1 }))
  }
  const content = tab === 'home' ? <Home key={`home-${tabRefreshVersion.home}`} onRequest={setRequestCard} onWrite={openWriter} guestProfile={guestProfile} refreshKey={feedVersion} /> : tab === 'board' ? <Board key={`board-${tabRefreshVersion.board}`} /> : tab === 'chats' ? <ChatHub key={`chats-${tabRefreshVersion.chats}`} onUnreadChanged={setUnreadChatCount} /> : <Profile guestProfile={guestProfile} onEdit={() => { setProfileEditorClosingBySwipe(false); setProfileEditorVisible(true) }} onCharge={() => { setPointPurchaseClosingBySwipe(false); setPointPurchaseVisible(true) }} onDeleted={accountDeleted} refreshKey={feedVersion} />
  const nav: Array<[Tab, string, string]> = [['home', '⌂', i18n.t('discover')], ['board', '▤', i18n.t('board')], ['chats', '◌', i18n.t('chats')], ['profile', '☺', i18n.t('myInfo')]]
  const tabBarEdges: Edge[] = ['bottom']
  const appSafeAreaEdges: Edge[] = Platform.OS === 'android'
    ? ['top']
    : ['top', 'right', 'left']

  return (
    <InsetSafeAreaView edges={appSafeAreaEdges} style={[styles.safe, styles.cleanPage]}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF9F5" />
      <View style={styles.flex}>{content}</View>
      <InsetSafeAreaView edges={tabBarEdges} style={[styles.tabBar, styles.cleanTabBar]}>
        {nav.map(([key, icon, label]) => (
          <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} style={styles.tab} onPress={() => selectTab(key)}>
            <View style={styles.tabIconWrap}>
              <Text style={[styles.tabIcon, tab === key && styles.tabActive]}>{icon}</Text>
              {key === 'chats' && unreadChatCount > 0 && (
                <Text style={styles.tabUnread}>{unreadChatCount > 99 ? '99+' : unreadChatCount}</Text>
              )}
            </View>
            <Text style={[styles.tabLabel, tab === key && styles.tabActive]}>{label}</Text>
          </Pressable>
        ))}
      </InsetSafeAreaView>
      <RequestComposer card={requestCard} onClose={() => setRequestCard(null)} onSent={() => setTab('chats')} />
      <Modal
        visible={writeModalVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setWriteModalVisible(false)
          setEditingCard(null)
        }}
      >
        <InsetSafeAreaView edges={['top', 'bottom']} style={styles.writeModalSafe}>
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
            <WriteCard guestProfile={guestProfile} initialCard={editingCard} onComplete={cardCreated} onCancel={() => { setWriteModalVisible(false); setEditingCard(null) }} />
          </KeyboardAvoidingView>
        </InsetSafeAreaView>
      </Modal>
      <Modal visible={profileEditorVisible} animationType={Platform.OS === 'android' ? 'fade' : profileEditorClosingBySwipe ? 'none' : 'slide'} onRequestClose={() => setProfileEditorVisible(false)}>
        <SwipeDismissView onDismissStart={() => setProfileEditorClosingBySwipe(true)} onDismiss={() => setProfileEditorVisible(false)}>
        <ProfileEditor
          profile={guestProfile}
          onClose={() => setProfileEditorVisible(false)}
          onSaved={next => {
            setGuestProfile(next)
            setProfileEditorVisible(false)
            setFeedVersion(value => value + 1)
          }}
        />
        </SwipeDismissView>
      </Modal>
      <Modal visible={pointPurchaseVisible} animationType={Platform.OS === 'android' ? 'fade' : pointPurchaseClosingBySwipe ? 'none' : 'slide'} onRequestClose={() => setPointPurchaseVisible(false)}>
        <SwipeDismissView onDismissStart={() => setPointPurchaseClosingBySwipe(true)} onDismiss={() => setPointPurchaseVisible(false)}>
        <PointPurchase
          onClose={() => setPointPurchaseVisible(false)}
          onBalanceChanged={() => setFeedVersion(value => value + 1)}
        />
        </SwipeDismissView>
      </Modal>
    </InsetSafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF7F9' }, flex: { flex: 1 }, row: { flexDirection: 'row', alignItems: 'center' }, rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hero: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 15, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, discoveryTitle: { color: '#3B1F2B', fontSize: 25, lineHeight: 32, fontWeight: '900', letterSpacing: -0.4 }, eyebrow: { color: '#B84A67', fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 3 }, discoveryHeaderActions: { marginTop: 3, marginLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, discoveryRefreshButton: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }, discoveryRefreshButtonBusy: { opacity: 0.7 }, discoveryRefreshIcon: { color: '#F26B4B', fontSize: 25, lineHeight: 30, fontWeight: '800' }, discoveryHeaderButtonPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] }, discoveryWriteButton: { width: 78, height: 40, backgroundColor: '#D94F70', borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#9F2949', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, discoveryWriteButtonText: { color: '#FFFFFF', fontSize: 13, lineHeight: 18, fontWeight: '900' },
  filterBar: { paddingHorizontal: 10, paddingTop: 0, paddingBottom: 16, gap: 4, alignItems: 'center', flexDirection: 'row' }, filter: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 22, backgroundColor: '#FFFCFD', borderWidth: 1, borderColor: '#F0DDE3' }, discoveryFilter: { flex: 1, paddingHorizontal: 2, paddingVertical: 9, alignItems: 'center' }, filterActive: { backgroundColor: '#D94F70', borderColor: '#D94F70' }, filterText: { color: '#77626A', fontWeight: '600', fontSize: 12 }, discoveryFilterText: { fontSize: 13, fontWeight: '700' }, filterTextActive: { color: '#FFFFFF' },
  discoveryList: { flex: 1 }, list: { flexGrow: 1, paddingHorizontal: 20, paddingBottom: 24, gap: 13 }, sectionTitle: { fontSize: 17, fontWeight: '800', color: '#3B1F2B', marginBottom: 2 }, myTalkSectionTitle: { marginLeft: 10 }, emptyText: { color: '#A58D96', fontSize: 13, lineHeight: 21, textAlign: 'center', paddingVertical: 42 }, card: { backgroundColor: '#FFFCFD', borderRadius: 22, padding: 17, borderWidth: 1, borderColor: '#F0D9E1', shadowColor: '#7B3048', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, cardPressed: { opacity: 0.8, transform: [{ scale: 0.992 }] }, cardHeader: { flexDirection: 'row', alignItems: 'center' }, avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#F6D6E0' }, avatarText: { color: '#4B5563', fontWeight: '800', fontSize: 17 }, cardIdentity: { flex: 1, marginLeft: 11 }, nickname: { color: '#3B1F2B', fontSize: 15, fontWeight: '800' }, genderBadge: { marginLeft: 7, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 9, overflow: 'hidden', fontSize: 10, fontWeight: '900' }, genderMale: { color: '#1D4ED8', backgroundColor: '#DBEAFE' }, genderFemale: { color: '#BE185D', backgroundColor: '#FCE7F3' }, genderOther: { color: '#57534E', backgroundColor: '#E7E5E4' }, verified: { color: '#D94F70', fontSize: 10, fontWeight: '700' }, meta: { color: '#A58D96', fontSize: 12, marginTop: 4 }, purposeBadge: { backgroundColor: '#FCE8EE', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 }, purposeText: { color: '#B83D60', fontSize: 11, fontWeight: '800' }, topic: { color: '#3B2730', fontSize: 16, lineHeight: 24, fontWeight: '700', marginTop: 16 }, tags: { flexDirection: 'row', gap: 7, marginTop: 11, flexWrap: 'wrap' }, tag: { color: '#806B73', fontSize: 12, backgroundColor: '#FAF1F4', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 }, myCardActions: { flexDirection: 'row', gap: 9 }, myCardActionButton: { flex: 1 }, requestButton: { marginTop: 15, backgroundColor: '#4A2634', borderRadius: 14, paddingVertical: 13, alignItems: 'center' }, editCardButton: { backgroundColor: '#D94F70' }, deleteCardButton: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FCA5A5' }, deleteCardButtonText: { color: '#DC2626', fontSize: 13, fontWeight: '800' }, requestButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  discoverySwipeActions: { width: 246, flexDirection: 'row', backgroundColor: '#F3F4F6' }, discoverySwipeAction: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }, discoverySwipeRequest: { backgroundColor: '#F26B4B' }, discoverySwipeDelete: { backgroundColor: '#64748B' }, discoverySwipeBlock: { backgroundColor: '#BE123C' }, discoverySwipeActionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', textAlign: 'center' },
  discoveryMenuOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.48)' }, discoveryMenuSheet: { width: '100%', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: '#FFFFFF' }, discoveryMenuHandle: { width: 42, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D6D3D1', marginBottom: 12 }, discoveryMenuTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900', paddingHorizontal: 4, paddingBottom: 10 }, discoveryMenuItem: { minHeight: 54, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: '#F0EAE6', flexDirection: 'row', alignItems: 'center' }, discoveryMenuRequestText: { flex: 1, color: '#E85D3B', fontSize: 15, fontWeight: '900' }, discoveryMenuChevron: { color: '#F26B4B', fontSize: 25, fontWeight: '700' }, discoveryMenuItemText: { color: '#374151', fontSize: 15, fontWeight: '900' }, discoveryMenuDangerItem: { borderBottomWidth: 1, borderBottomColor: '#F0EAE6' }, discoveryMenuDangerText: { color: '#BE123C', fontSize: 15, fontWeight: '900' }, discoveryMenuDescription: { flex: 1, color: '#9CA3AF', fontSize: 11, textAlign: 'right', marginLeft: 12 }, discoveryMenuCancel: { minHeight: 50, marginTop: 12, borderRadius: 14, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' }, discoveryMenuCancelText: { color: '#4B5563', fontSize: 14, fontWeight: '900' },
  cardMain: { flexDirection: 'row', alignItems: 'center' }, cardTextContent: { flex: 1, marginLeft: 14 }, compactProfileLine: { flexDirection: 'row', alignItems: 'center', marginTop: 14 }, compactProfileText: { flexShrink: 1, color: '#3B1F2B' }, compactAge: { color: '#806B73', fontSize: 12, fontWeight: '800' }, compactMeta: { color: '#8E7680', fontSize: 12, fontWeight: '600' }, nicknameMale: { color: '#2563EB' }, nicknameFemale: { color: '#E04468' }, topicPurposeLine: { flexDirection: 'row', alignItems: 'center', gap: 10 }, topicInline: { flex: 1, color: '#3B2730', fontSize: 16, lineHeight: 24, fontWeight: '700' },
  photoPreviewOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }, photoPreviewSafe: { flex: 1 }, photoPreviewHeader: { minHeight: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, photoPreviewName: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', marginRight: 16 }, photoPreviewHint: { color: '#A8A29E', fontSize: 11, marginTop: 3 }, photoPreviewClose: { minWidth: 52, minHeight: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }, photoPreviewCloseText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, photoZoomArea: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, photoPreviewImage: { width: '100%', height: '100%' },
  page: { flexGrow: 1, padding: 20, backgroundColor: '#FFF9F5' }, pageTitle: { color: '#1F2937', fontSize: 25, fontWeight: '800', marginTop: 7 }, pageSubtitle: { color: '#7C6F68', marginTop: 7, marginBottom: 26 }, label: { color: '#374151', fontWeight: '800', fontSize: 14, marginTop: 18, marginBottom: 10 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, textarea: { minHeight: 130, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderRadius: 16, padding: 15, textAlignVertical: 'top', color: '#1F2937', fontSize: 15, lineHeight: 22 }, counter: { color: '#9CA3AF', fontSize: 11, alignSelf: 'flex-end', marginTop: 6 }, counterWarning: { color: '#DC2626' }, guide: { backgroundColor: '#F5F3FF', borderRadius: 14, padding: 14, marginTop: 20 }, guideTitle: { color: '#5B21B6', fontSize: 13, fontWeight: '800' }, guideText: { color: '#6D5C85', fontSize: 12, lineHeight: 18, marginTop: 4 }, primaryButton: { backgroundColor: '#F26B4B', borderRadius: 15, padding: 16, alignItems: 'center', marginTop: 24 }, primaryButtonText: { color: '#FFFFFF', fontWeight: '800' }, disabled: { opacity: 0.4 },
  authorPreview: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6', borderRadius: 16, padding: 13, flexDirection: 'row', alignItems: 'center', marginBottom: 4 }, authorPreviewBody: { flex: 1, marginLeft: 11 }, authorPreviewName: { color: '#1F2937', fontSize: 15, fontWeight: '900' }, authorPreviewMeta: { color: '#8B817A', fontSize: 11, lineHeight: 17, marginTop: 4 }, writeModalSafe: { flex: 1, backgroundColor: '#FFF9F5' }, writeModalHeader: { height: 56, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' }, writeModalHeaderButton: { width: 76, minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' }, writeModalClose: { color: '#F26B4B', fontSize: 15, fontWeight: '900' }, writeModalTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' }, writeModalSpacer: { width: 32 },
  chatRow: { flexDirection: 'row', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#EEE7E2' }, chatBody: { flex: 1, marginLeft: 12, justifyContent: 'center' }, chatTime: { color: '#A8A29E', fontSize: 11 }, chatMessage: { color: '#78716C', fontSize: 13, marginTop: 7, flex: 1 }, unread: { color: '#FFFFFF', backgroundColor: '#F26B4B', minWidth: 20, height: 20, borderRadius: 10, textAlign: 'center', lineHeight: 20, fontSize: 11, fontWeight: '800', marginLeft: 8 },
  profilePageHeader: { paddingTop: 24, paddingBottom: 15 }, profilePageTitle: { fontWeight: '900', lineHeight: 32, marginTop: 0 }, profilePageSubtitle: { color: '#F26B4B', fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 3 }, profileCard: { minHeight: 82, backgroundColor: '#FFFFFF', borderRadius: 18, paddingHorizontal: 15, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#F0EAE6' }, profileCardPressed: { opacity: 0.82 }, profileSummary: { flex: 1, minWidth: 0, marginLeft: 12 }, profileName: { color: '#1F2937', fontSize: 16, lineHeight: 21, fontWeight: '800' }, profileMeta: { color: '#8B817A', fontSize: 11, lineHeight: 16, marginTop: 3 }, pointCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 17, marginTop: 14, borderWidth: 1, borderColor: '#F0EAE6' }, pointCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pointCardHeading: { flex: 1, marginRight: 12 }, pointCardTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' }, pointCardDescription: { color: '#9A3412', fontSize: 11, marginTop: 4 }, pointValue: { color: '#E85D3B', fontSize: 20, fontWeight: '900' }, chargeButton: { width: '100%', minHeight: 46, borderRadius: 12, backgroundColor: '#FFF0F4', borderWidth: 1, borderColor: '#F3CCD8', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 15, marginTop: 14 }, chargeButtonText: { color: '#B83D60', fontSize: 13, fontWeight: '900' }, chargeButtonArrow: { color: '#D94F70', fontSize: 20, fontWeight: '900' }, rewardActionRow: { marginTop: 10, flexDirection: 'row', gap: 8 }, rewardActionButton: { flex: 1, minWidth: 0, minHeight: 46, borderRadius: 12, paddingHorizontal: 8, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }, attendanceButton: { backgroundColor: '#F26B4B' }, attendanceButtonDisabled: { backgroundColor: '#E7E5E4' }, attendanceButtonText: { color: '#FFFFFF', fontSize: 10, lineHeight: 14, fontWeight: '900', textAlign: 'center' }, rewardActionIcon: { color: '#FFFFFF', fontSize: 12, lineHeight: 15, fontWeight: '900' }, rewardedAdButton: { borderWidth: 1, borderColor: '#D7CCF5', backgroundColor: '#F4F0FF' }, rewardedAdIcon: { color: '#7257B7' }, rewardedAdButtonText: { color: '#5B3E9B', fontSize: 10, lineHeight: 14, fontWeight: '900', textAlign: 'center' }, profileEditButton: { minWidth: 82, minHeight: 38, marginLeft: 10, paddingHorizontal: 11, borderRadius: 11, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' }, profileEditButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' }, profileEditor: { padding: 16, paddingBottom: 42, backgroundColor: '#FFF9F5' }, profilePhotoGroup: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6', borderRadius: 18, padding: 17 }, profileDetailsGroup: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0EAE6', borderRadius: 18, padding: 17, marginTop: 14 }, profileGroupTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' }, profileGroupDescription: { color: '#8B817A', fontSize: 11, lineHeight: 17, marginTop: 4 }, profilePhotoPicker: { alignItems: 'center', marginTop: 16 }, profilePhotoChangeText: { color: '#F26B4B', fontSize: 12, fontWeight: '800', marginTop: 8 }, profilePhotoSaveButton: { minHeight: 44, borderRadius: 13, backgroundColor: '#FFF0E9', alignItems: 'center', justifyContent: 'center', marginTop: 14 }, profilePhotoSaveText: { color: '#E85D3B', fontSize: 13, fontWeight: '900' }, profileInput: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, color: '#1F2937', fontSize: 15 }, profileAgeRow: { flexDirection: 'row', alignItems: 'center' }, profileAgeInput: { flex: 1 }, profileAgeSuffix: { marginLeft: 9, color: '#57534E', fontWeight: '700' }, profileInterestLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, profileInterestCount: { color: '#F26B4B', fontSize: 12, fontWeight: '800', marginTop: 18, marginBottom: 10 }, profileKeyboardAction: { backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }, profileKeyboardButton: { marginTop: 0 }, privacyNote: { color: '#A8A29E', fontSize: 11, lineHeight: 17, marginTop: 8 },
  profilePageLayout: { paddingTop: 0 }, profilePageIos: { paddingTop: 0, paddingBottom: 13 }, profilePageHeaderIos: { paddingBottom: 12 }, profileCardIos: { minHeight: 78, paddingVertical: 11 }, pointCardIos: { paddingVertical: 15, marginTop: 11 },
  writeCardContainer: { flex: 1 }, writeCardPage: { paddingTop: 12, paddingBottom: 28 }, writeCardFooter: { backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, flexDirection: 'row', gap: 9 }, writeCardCancel: { flex: 1, minHeight: 50, borderRadius: 15, backgroundColor: '#E7E5E4', alignItems: 'center', justifyContent: 'center' }, writeCardCancelText: { color: '#57534E', fontSize: 14, fontWeight: '900' }, writeCardSubmit: { flex: 2, minHeight: 50, marginTop: 0, justifyContent: 'center' },
  tabBar: { flexDirection: 'row', backgroundColor: '#FFFCFD', borderTopWidth: 1, borderTopColor: '#F0DDE3', paddingVertical: 7, paddingBottom: 10, shadowColor: '#7B3048', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: -3 }, elevation: 5 }, tab: { flex: 1, alignItems: 'center' }, tabIconWrap: { position: 'relative', minWidth: 30, alignItems: 'center' }, tabIcon: { color: '#B39DA5', fontSize: 21, height: 25 }, tabUnread: { position: 'absolute', top: -4, right: -8, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#D92F5A', color: '#FFFFFF', fontSize: 9, lineHeight: 18, textAlign: 'center', fontWeight: '900', overflow: 'hidden' }, tabLabel: { color: '#A58D96', fontSize: 10, fontWeight: '600' }, tabActive: { color: '#D94F70' },
  cleanPage: { backgroundColor: '#F7F9FA' }, cleanCard: { backgroundColor: '#FFFFFF', borderColor: '#E5E7EB', shadowOpacity: 0, elevation: 0 }, cleanTabBar: { backgroundColor: '#FFFFFF', borderTopColor: '#E5E7EB', shadowOpacity: 0, elevation: 3 },
  originalDiscoveryPage: { backgroundColor: '#FFF9F5' }, originalDiscoveryTitle: { color: '#1F2937' }, originalDiscoveryAccent: { color: '#F26B4B' }, originalDiscoveryButton: { backgroundColor: '#F26B4B', borderColor: '#F26B4B', shadowOpacity: 0, elevation: 0 }, originalDiscoveryFilter: { backgroundColor: '#FFFFFF', borderColor: '#EDE7E2' }, originalDiscoveryFilterText: { color: '#6B7280' }, originalDiscoveryCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderColor: '#F0EAE6', shadowOpacity: 0, elevation: 0 }, originalPurposeBadge: { backgroundColor: '#FFF0E9', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6 }, originalPurposeText: { color: '#E85D3B', fontWeight: '700' }, originalDiscoveryBody: { color: '#292524' }, originalProfileText: { color: '#1F2937' }, originalDiscoveryMeta: { color: '#78716C' }, originalAvatar: { borderWidth: 0 },
  discoveryCountryFilter: { flex: 1.45, paddingHorizontal: 3, borderColor: '#F6B49F', backgroundColor: '#FFF7F2', flexDirection: 'row', justifyContent: 'center' }, discoveryCountryFilterText: { flexShrink: 1, color: '#C24120', fontSize: 9 },
  countryPickerOverlay: { flex: 1, paddingHorizontal: 22, backgroundColor: 'rgba(15,23,42,0.46)', alignItems: 'center', justifyContent: 'center' }, countryPickerSheet: { width: '100%', maxWidth: 420, maxHeight: '72%', borderRadius: 22, backgroundColor: '#FFF9F5', padding: 18 }, countryPickerHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }, countryPickerTitle: { color: '#1F2937', fontSize: 19, fontWeight: '900' }, countryPickerDescription: { color: '#78716C', fontSize: 11, lineHeight: 17, marginTop: 4 }, countryPickerClose: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F3EDE9', alignItems: 'center', justifyContent: 'center', marginLeft: 12 }, countryPickerCloseText: { color: '#78716C', fontSize: 23, lineHeight: 25, fontWeight: '700' }, countryPickerList: { flexGrow: 0 }, countryPickerListContent: { paddingBottom: 2 }, countryPickerOption: { minHeight: 52, paddingHorizontal: 16, marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' }, countryPickerOptionActive: { borderColor: '#F26B4B', backgroundColor: '#FFF0E9' }, countryPickerOptionText: { flex: 1, color: '#4B5563', fontSize: 14, fontWeight: '800' }, countryPickerOptionTextActive: { color: '#C24120', fontWeight: '900' }, countryPickerCheck: { color: '#F26B4B', fontSize: 18, fontWeight: '900' },
  wideDiscoveryList: { paddingHorizontal: 0 }, wideDiscoveryCard: { paddingHorizontal: 10, paddingVertical: 14, borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0 },
  profileAgeSelector: { minHeight: 50, paddingVertical: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  profileAgeValue: { color: '#1F2937', fontSize: 15, fontWeight: '800' },
  profileAgeChevron: { color: '#A8A29E', fontSize: 20, fontWeight: '900' },
})
